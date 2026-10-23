import { createHash, createHmac } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { AppConfig, PendingNotification, XPost } from "./types";
import { formatTime, type ResetEvent } from "./events";

export type NotificationTarget = {
  id: string;
  channel: string;
  send: (item: PendingNotification) => Promise<void>;
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
const labels = {
  reset: "额度重置",
  bank_credit: "Bank 重置额度",
  bank_expiry: "Bank 有效期",
  mention: "Reset 相关讨论（未确认）",
};
const statuses = {
  scheduled: "预告",
  completed: "已宣布完成",
  announced: "公告",
  uncertain: "未确认",
};
export function renderText(
  post: XPost,
  events: ResetEvent[],
  timezone: string,
): string {
  return [
    `Reset Signal · @${new URL(post.url).pathname.split("/")[1]}`,
    ...events.map(
      (e) =>
        `${labels[e.type]} · ${statuses[e.status]}\n${formatTime(e.time, timezone)}`,
    ),
    "",
    post.text,
    "",
    post.url,
  ].join("\n");
}
export function renderEmail(
  post: XPost,
  username: string,
  keyword: string,
  events: ResetEvent[] = [],
  timezone = "Asia/Shanghai",
): string {
  const summary = events.length
    ? events.map((event) => {
        const status = statuses[event.status];
        const time = formatTime(event.time, timezone);
        return `${labels[event.type]}｜${status}｜${time}`;
      })
    : ["仅检测到相关消息，尚无可确认的重置事件"];
  const title = events.some((event) => event.status === "completed")
    ? "Codex 额度重置｜已宣布完成"
    : events.some((event) => event.status === "scheduled")
      ? "Codex 额度重置｜预告"
      : "Codex 额度重置｜待确认";
  const lines = summary.map((line) => `<li style="margin:8px 0">${escapeHtml(line)}</li>`).join("");
  return `<!doctype html><html lang="zh-CN"><body style="font-family:Arial,sans-serif;max-width:600px;margin:24px auto;color:#202124;line-height:1.7"><h2>${escapeHtml(title)}</h2><p>来源：@${escapeHtml(username)} · 关键词：${escapeHtml(keyword)}</p><ul>${lines}</ul><p style="color:#666">以上为原文规则提取的摘要，预告不等于实际到账，请以 Codex 额度页面为准。</p><p><a href="${escapeHtml(post.url)}">查看原始消息</a></p></body></html>`;
}

/** Recipient identity is hashed; no tokens, email addresses or URLs enter state. */
export function createTargets(
  config: AppConfig,
  fetcher: typeof fetch = fetch,
): NotificationTarget[] {
  const targets: NotificationTarget[] = [];
  const add = (
    channel: string,
    identity: string,
    send: NotificationTarget["send"],
  ) => {
    const id = `${channel}:${digest(identity).slice(0, 24)}`;
    if (!targets.some((t) => t.id === id)) targets.push({ id, channel, send });
  };
  const request = async (
    url: string | URL,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
    } catch {
      throw new Error("Notification request failed or timed out");
    }
    if (!response.ok) throw new Error(`Notification HTTP ${response.status}`);
    return response;
  };
  if (config.githubSummaryPath)
    add("github-actions", "job-summary", async (item) => {
      const quoted = renderText(item.post, item.events, config.timezone)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      await appendFile(
        config.githubSummaryPath!,
        `### Reset Signal\n\n${quoted}\n\nDelivery ID: \`${item.key.slice(0, 16)}…\`\n\n`,
        "utf8",
      );
    });
  for (const recipient of config.emailTo)
    add("email", recipient, async (item) => {
      await request(
        "https://api.resend.com/emails",
        {
          from: config.emailFrom,
          to: [recipient],
          subject: item.events.some((event) => event.status === "completed")
            ? "Codex 额度重置｜已宣布完成"
            : item.events.some((event) => event.status === "scheduled")
              ? "Codex 额度重置｜预告"
              : "Codex 额度重置｜待确认",
          html: renderEmail(
            item.post,
            config.username,
            config.keyword,
            item.events,
            config.timezone,
          ),
          text: [
            "Codex 额度重置通知",
            ...item.events.map((event) => `${labels[event.type]}｜${statuses[event.status]}｜${formatTime(event.time, config.timezone)}`),
            ...(item.events.length ? [] : ["仅检测到相关消息，尚无可确认的重置事件"]),
            "预告不等于实际到账，请以 Codex 额度页面为准。",
            item.post.url,
          ].join("\n"),
        },
        {
          Authorization: `Bearer ${config.resendApiKey}`,
          "Idempotency-Key": digest(`${item.key}:${recipient}`),
        },
      );
    });
  for (const recipient of config.smsTo)
    add("sms", recipient, async (item) => {
      const text = renderText(item.post, item.events, config.timezone);
      let response: Response;
      try {
        response = await fetcher(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid!)}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              To: recipient,
              From: config.twilioFrom!,
              Body: `${text.slice(0, 1200)}\n${item.post.url}`,
            }),
            signal: AbortSignal.timeout(20_000),
            redirect: "error",
          },
        );
      } catch {
        throw new Error("SMS request failed or timed out");
      }
      if (!response.ok) throw new Error(`SMS HTTP ${response.status}`);
    });
  for (const chat of config.telegramChatIds)
    add(
      "telegram",
      `${config.telegramBotToken?.split(":")[0]}:${chat}`,
      async (item) => {
        const response = await request(
          `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
          {
            chat_id: chat,
            text: `${renderText(item.post, item.events, config.timezone).slice(0, 3800)}\n${item.post.url}`,
            link_preview_options: { is_disabled: true },
          },
        );
        const result = (await response.json()) as { ok?: boolean };
        if (!result.ok) throw new Error("Telegram rejected notification");
      },
    );
  for (const endpoint of config.discordWebhookUrls)
    add(
      "discord",
      new URL(endpoint).pathname.replace(/\/[^/]+$/, ""),
      async (item) => {
        const url = new URL(endpoint);
        url.searchParams.set("wait", "true");
        await request(url, {
          content: `${renderText(item.post, item.events, config.timezone).slice(0, 1700)}\n${item.post.url}`,
          allowed_mentions: { parse: [] },
        });
      },
    );
  for (const endpoint of config.webhookUrls)
    add("webhook", endpoint, async (item) => {
      const body = {
        schema_version: 1,
        delivery_id: item.key,
        timezone: config.timezone,
        post: item.post,
        events: item.events,
        text: renderText(item.post, item.events, config.timezone),
      };
      const headers: Record<string, string> = { "Idempotency-Key": item.key };
      if (config.webhookSecret)
        headers["X-Reset-Signature"] =
          `sha256=${createHmac("sha256", config.webhookSecret).update(JSON.stringify(body)).digest("hex")}`;
      const debugId = item.key.slice(0, 12);
      const host = new URL(endpoint).hostname;
      const startedAt = Date.now();
      if (config.webhookDebug)
        console.log(
          `[webhook] sending ${debugId} to ${host} (signed=${config.webhookSecret ? "yes" : "no"})`,
        );
      try {
        const response = await request(endpoint, body, headers);
        if (config.webhookDebug)
          console.log(
            `[webhook] ${debugId} -> HTTP ${response.status} in ${Date.now() - startedAt}ms`,
          );
      } catch (error) {
        if (config.webhookDebug)
          console.error(
            `[webhook] ${debugId} -> failed in ${Date.now() - startedAt}ms`,
          );
        throw error;
      }
    });
  return targets;
}
