
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ModalBuilder,
  TextInputBuilder,
  ButtonStyle,
  TextInputStyle,
} from "discord.js";
import { Complaint } from "../models/Complaint.js";
import { sendInProgressEmail, sendRejectedEmail, sendResolvedEmail } from "../mailer.js";

const URGENCY_CATEGORY_NAMES = {
  low: "Low Urgency",
  medium: "Medium Urgency",
  high: "High Urgency",
};

const URGENCY_COLORS = {
  low: 0x22c55e,
  medium: 0xf59e0b,
  high: 0xef4444,
};

const URGENCY_EMOJI = {
  low: "🟢",
  medium: "🟡",
  high: "🔴",
};

let client = null;
let readyPromise = null;

/**
 * Initialize and login the Discord bot
 */
export function initDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log("[Discord] DISCORD_BOT_TOKEN not set — bot disabled");
    return null;
  }

  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  readyPromise = new Promise((resolve, reject) => {
    client.once("ready", () => {
      console.log(`[Discord] Bot logged in as ${client.user.tag}`);
      resolve(client);
    });
  });

  client.login(token).catch((err) => {
    console.error("[Discord] Login failed:", err.message);
    readyPromise = Promise.reject(err);
  });

  setupInteractionHandlers(client);
  return client;
}

/**
 * Build action buttons for a complaint
 */
function buildComplaintButtons(complaintId) {
  const id = complaintId.toUpperCase();
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`resolve_${id}`)
      .setLabel("Mark as Resolved")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`fake_${id}`)
      .setLabel("Fake Report")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`progress_${id}`)
      .setLabel("In Progress")
      .setStyle(ButtonStyle.Primary)
  );
}

/**
 * Setup button and modal interaction handlers
 */
function setupInteractionHandlers(c) {
  c.on("interactionCreate", async (interaction) => {
    if (interaction.isButton()) {
      await handleButtonClick(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }
  });
}

/**
 * Handle button click — show modal with remark (and proof for resolve)
 */
async function handleButtonClick(interaction) {
  const customId = interaction.customId;
  const match = customId.match(/^(resolve|fake|progress)_(.+)$/);
  if (!match) return;

  const [, action, complaintId] = match;
  const id = complaintId.trim().toUpperCase();

  const modal = new ModalBuilder()
    .setCustomId(`${action}_${id}`)
    .setTitle(action === "resolve" ? "Mark as Resolved" : action === "fake" ? "Fake Report" : "In Progress");

  const remarkInput = new TextInputBuilder()
    .setCustomId("remark")
    .setLabel("Remark")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Enter your remark...")
    .setRequired(true)
    .setMaxLength(1000);

  modal.addComponents(new ActionRowBuilder().addComponents(remarkInput));

  if (action === "resolve") {
    const proofInput = new TextInputBuilder()
      .setCustomId("proof")
      .setLabel("Proof (Google Drive link)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("https://drive.google.com/...")
      .setRequired(true)
      .setMaxLength(500);
    modal.addComponents(new ActionRowBuilder().addComponents(proofInput));
  }

  await interaction.showModal(modal);
}

/**
 * Handle modal submit — update MongoDB and Discord message
 */
async function handleModalSubmit(interaction) {
  const customId = interaction.customId;
  const match = customId.match(/^(resolve|fake|progress)_(.+)$/);
  if (!match) return;

  const [, action, complaintId] = match;
  const id = complaintId.trim().toUpperCase();
  const remark = interaction.fields.getTextInputValue("remark");
  const proof = action === "resolve" ? interaction.fields.getTextInputValue("proof") : null;

  await interaction.deferUpdate();

  try {
    const complaint = await Complaint.findOne({ id });
    if (!complaint) {
      await interaction.followUp({ content: `Complaint ${id} not found.`, ephemeral: true }).catch(() => {});
      return;
    }

    let newStatus, newProgress;
    if (action === "resolve") {
      newStatus = "Resolved";
      newProgress = 100;
    } else if (action === "fake") {
      newStatus = "Rejected";
      newProgress = 0;
    } else {
      newStatus = "In Progress";
      newProgress = 60;
    }

    await Complaint.updateOne(
      { id },
      {
        $set: {
          status: newStatus,
          progress: newProgress,
          remarks: remark,
          ...(proof && { proof }),
        },
      }
    );

    const updated = await Complaint.findOne({ id });
    const actioner = interaction.user.tag || interaction.user.username;
    const embed = buildComplaintEmbed(updated, actioner);
    const components = updated.status === "Resolved" || updated.status === "Rejected"
      ? [] // Remove buttons when resolved/rejected
      : [buildComplaintButtons(id)];

    await interaction.message.edit({ embeds: [embed], components });
    await interaction.followUp({
      content: `Complaint ${id} updated: **${newStatus}**${remark ? ` — ${remark.slice(0, 100)}${remark.length > 100 ? "…" : ""}` : ""}`,
      ephemeral: true,
    }).catch(() => {});

    // Send status email to complainant
    if (newStatus === "In Progress") {
      sendInProgressEmail(updated).catch((err) => console.error("[Mail] In progress email failed:", err));
    } else if (newStatus === "Rejected") {
      sendRejectedEmail(updated).catch((err) => console.error("[Mail] Rejected email failed:", err));
    } else if (newStatus === "Resolved") {
      sendResolvedEmail(updated).catch((err) => console.error("[Mail] Resolved email failed:", err));
    }

    if (newStatus === "Resolved" || newStatus === "Rejected") {
      const actioner = interaction.user.tag || interaction.user.username;
      const logEmbed = new EmbedBuilder()
        .setTitle(`${newStatus} — ${id}`)
        .setDescription(
          newStatus === "Resolved"
            ? "Complaint has been resolved and channel closed."
            : "Report marked as fake and channel closed."
        )
        .setColor(newStatus === "Resolved" ? 0x22c55e : 0xef4444)
        .addFields(
          { name: "Complaint ID", value: id, inline: true },
          { name: "Category", value: updated.category, inline: true },
          { name: "Location", value: formatLocationWithLink(updated.location), inline: true },
          { name: "Remark", value: remark, inline: false },
          { name: "Actioned by", value: actioner, inline: true }
        );
      if (proof) {
        logEmbed.addFields({ name: "Proof", value: `[View Proof](${proof})`, inline: false });
      }
      logEmbed.setFooter({ text: `Last seen by ${actioner}` }).setTimestamp();

      const logChannel = await interaction.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
      if (logChannel) {
        await logChannel.send({ embeds: [logEmbed] }).catch((err) =>
          console.error("[Discord] Failed to log to channel:", err.message)
        );
      }

      await interaction.channel.delete().catch((err) =>
        console.error("[Discord] Failed to delete channel:", err.message)
      );
    }
  } catch (err) {
    console.error("[Discord] Modal submit error:", err);
    await interaction.followUp({
      content: `Failed to update complaint: ${err.message}`,
      ephemeral: true,
    }).catch(() => {});
  }
}

const LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID || "1475071667528007864";

function parseLocationCoords(location) {
  if (!location || typeof location !== "string") return null;
  const match = location.match(/(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/);
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function formatLocationWithLink(location) {
  const coords = parseLocationCoords(location);
  if (coords) {
    const mapUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
    return `[${location}](${mapUrl})`;
  }
  return location;
}

/**
 * Build embed from complaint (including remarks/proof when set)
 * @param {Object} complaint - Complaint document
 * @param {string} [actioner] - Username of who performed the last action (for footer)
 */
function buildComplaintEmbed(complaint, actioner) {
  const urgency = (complaint.urgency || "medium").toLowerCase();
  const emoji = URGENCY_EMOJI[urgency] ?? URGENCY_EMOJI.medium;
  const color = URGENCY_COLORS[urgency] ?? URGENCY_COLORS.medium;

  const fields = [
    { name: "Complaint ID", value: complaint.id, inline: true },
    { name: "Urgency", value: `${emoji} ${urgency.charAt(0).toUpperCase() + urgency.slice(1)}`, inline: true },
    { name: "Category", value: complaint.category, inline: true },
    { name: "Location", value: formatLocationWithLink(complaint.location), inline: true },
    { name: "Date", value: complaint.date, inline: true },
    { name: "Status", value: complaint.status || "Pending", inline: true },
    { name: "Name", value: complaint.name, inline: true },
    { name: "Phone", value: complaint.phone, inline: true },
    { name: "Email", value: complaint.email, inline: true },
    { name: "Description", value: complaint.description || "—", inline: false },
  ];

  if (complaint.remarks) {
    fields.push({ name: "Remark", value: complaint.remarks, inline: false });
  }
  if (complaint.proof) {
    fields.push({ name: "Proof", value: `[View Proof](${complaint.proof})`, inline: false });
  }
  const images = complaint.imageUrls?.length ? complaint.imageUrls : (complaint.imageUrl ? [complaint.imageUrl] : []);
  if (images.length > 0) {
    fields.push({
      name: images.length === 1 ? "Image" : "Images",
      value: images.map((url, i) => `[Image ${i + 1}](${url})`).join(" • "),
      inline: false,
    });
  }

  const footerText = actioner
    ? `Last seen by ${actioner}`
    : "Civic Complaint Management System";

  return new EmbedBuilder()
    .setTitle(`Civic Complaint — ${complaint.id}`)
    .setDescription(
      complaint.status === "Resolved"
        ? "This complaint has been resolved."
        : complaint.status === "Rejected"
        ? "This report was marked as fake."
        : "A new complaint has been submitted and stored in the system."
    )
    .setColor(color)
    .addFields(fields)
    .setFooter({ text: footerText })
    .setTimestamp();
}

async function getOrCreateCategory(guild, urgency) {
  const name = URGENCY_CATEGORY_NAMES[urgency] ?? URGENCY_CATEGORY_NAMES.medium;
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name
  );
  if (existing) return existing;

  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
  });
}

/**
 * Create a channel under the urgency category and send the complaint embed with buttons
 */
export async function sendComplaintToDiscord(complaint) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !guildId) {
    console.log("[Discord] DISCORD_BOT_TOKEN or DISCORD_GUILD_ID not set — skipping");
    return { success: false };
  }

  if (!client || !readyPromise) {
    initDiscordBot();
  }

  try {
    const guild = await readyPromise.then((c) => c.guilds.fetch(guildId));
    if (!guild) {
      throw new Error(`Guild ${guildId} not found. Ensure bot is in the server.`);
    }

    const urgency = (complaint.urgency || "medium").toLowerCase();
    const category = await getOrCreateCategory(guild, urgency);

    const channelName = `complaint-${complaint.id.toLowerCase().replace(/\s/g, "-")}`;

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Civic Complaint ${complaint.id} — ${complaint.category}`,
    });

    const embed = buildComplaintEmbed(complaint);
    const components = [buildComplaintButtons(complaint.id)];

    await channel.send({ embeds: [embed], components });

    console.log(`[Discord] Complaint ${complaint.id} → channel #${channel.name} under ${category.name}`);
    return { success: true, channelId: channel.id };
  } catch (err) {
    console.error("[Discord] Error:", err.message);
    return { success: false };
  }
}
