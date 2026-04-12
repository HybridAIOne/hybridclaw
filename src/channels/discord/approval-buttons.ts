import {
  type ActionRow,
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonComponent,
  ButtonStyle,
  ComponentType,
  type Message,
  type MessageActionRowComponent,
} from 'discord.js';
import { APPROVAL_BUTTON_LABELS } from '../../gateway/approval-button-labels.js';

export function buildApprovalActionRow(
  approvalId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:yes:${approvalId}`)
      .setLabel(APPROVAL_BUTTON_LABELS.yes)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`approve:session:${approvalId}`)
      .setLabel(APPROVAL_BUTTON_LABELS.session)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`approve:agent:${approvalId}`)
      .setLabel(APPROVAL_BUTTON_LABELS.agent)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`approve:all:${approvalId}`)
      .setLabel(APPROVAL_BUTTON_LABELS.all)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`approve:no:${approvalId}`)
      .setLabel(APPROVAL_BUTTON_LABELS.no)
      .setStyle(ButtonStyle.Danger),
  );
}

export function parseApprovalCustomId(
  customId: string,
): { action: string; approvalId: string } | null {
  const match = customId.match(
    /^approve:(yes|session|all|agent|no):([A-Za-z0-9-]+)$/,
  );
  if (!match) return null;
  const [, action, approvalId] = match;
  return { action, approvalId };
}

export async function disableApprovalButtons(message: Message): Promise<void> {
  const rows = message.components
    .filter(
      (row): row is ActionRow<MessageActionRowComponent> =>
        row.type === ComponentType.ActionRow,
    )
    .map((row) => {
      const buttons = row.components
        .filter(
          (component): component is ButtonComponent =>
            component.type === ComponentType.Button,
        )
        .map((component) => ButtonBuilder.from(component).setDisabled(true));
      if (buttons.length === 0) return null;
      return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
    })
    .filter(Boolean) as ActionRowBuilder<ButtonBuilder>[];

  if (rows.length === 0) return;
  await message.edit({ components: rows });
}
