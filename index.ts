import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

export { ModeratorRoom } from "./moderator-room";

interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  MODERATOR_ROOM: DurableObjectNamespace;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  RESEND_API_KEY: string;
  STREAM_CUSTOMER_CODE: string;
  STREAM_LIVE_INPUT_UID: string;
  CF_REALTIME_APP_ID: string;
  CF_REALTIME_APP_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_STREAM_API_TOKEN: string;
}

const app = new Hono<{ Bindings: Bindings }>();

const SESSION_TTL_SECONDS = 6 * 60 * 60; // 6 saat
const OTP_TTL_SECONDS = 10 * 60; // 10 dakika
const OTP_MAX_ATTEMPTS = 5;

// ---------- Yardımcı fonksiyonlar ----------

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateOtpCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function requireSession(c: any): Promise<string | null> {
  const token = getCookie(c, "session");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = (await c.env.DB.prepare(
    "SELECT email, expires_at FROM sessions WHERE token_hash = ?",
  )
    .bind(tokenHash)
    .first()) as { email: string; expires_at: number } | null;
  if (!row) return null;
  if (row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return row.email;
}

// requireSession ile aynı, ama izleme süresi kaydı için oturumun hangi etkinliğe
// bağlı açıldığını (varsa) da döndürür.
async function requireSessionWithEvent(
  c: any,
): Promise<{ email: string; eventId: number | null } | null> {
  const token = getCookie(c, "session");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = (await c.env.DB.prepare(
    "SELECT email, event_id, expires_at FROM sessions WHERE token_hash = ?",
  )
    .bind(tokenHash)
    .first()) as {
    email: string;
    event_id: number | null;
    expires_at: number;
  } | null;
  if (!row) return null;
  if (row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return { email: row.email, eventId: row.event_id };
}

function checkAdminAuth(c: any): boolean {
  const pw = c.req.header("x-admin-password");
  return !!pw && pw === c.env.ADMIN_PASSWORD;
}

async function requireModerator(c: any): Promise<boolean> {
  const token = getCookie(c, "mod_session");
  if (!token) return false;
  const row = (await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'mod_session_token'",
  ).first()) as { value: string } | null;
  return !!row && row.value === token;
}

async function createSessionAndSetCookie(
  c: any,
  email: string,
  eventId: number | null = null,
) {
  const rawToken = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

  await c.env.DB.prepare(
    "INSERT INTO sessions (token_hash, email, event_id, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(tokenHash, email, eventId, expiresAt)
    .run();

  setCookie(c, "session", rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

async function sendEmail(
  env: Bindings,
  to: string,
  subject: string,
  html: string,
  attachments?: { filename: string; content: string }[],
) {
  const body: any = {
    from: "onboarding@resend.dev",
    to,
    subject,
    html,
  };
  if (attachments) body.attachments = attachments;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API hatası: ${res.status} ${text}`);
  }
}

function formatDisplayDate(isoDate: string): string {
  const months = [
    "Ocak",
    "Şubat",
    "Mart",
    "Nisan",
    "Mayıs",
    "Haziran",
    "Temmuz",
    "Ağustos",
    "Eylül",
    "Ekim",
    "Kasım",
    "Aralık",
  ];
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  return `${d} ${months[m - 1]} ${y}`;
}

// Turkiye saatine (UTC+3) göre .ics tarih/saat formatı üretir
function buildIcsContent(opts: {
  uid: string;
  title: string;
  projectName: string;
  eventDate: string;
  eventTime: string;
  siteUrl: string;
  attendeeEmail?: string;
  attendeeName?: string;
  asInvite?: boolean;
}): string {
  const [y, m, d] = opts.eventDate.split("-").map(Number);
  const [hh, mm] = opts.eventTime.split(":").map(Number);
  // Turkiye UTC+3 -> UTC'ye çevir
  const startUtc = new Date(Date.UTC(y, m - 1, d, hh - 3, mm));
  const endUtc = new Date(startUtc.getTime() + 60 * 60 * 1000);

  const fmt = (dt: Date) =>
    dt.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Turk Kizilay//Donor Stream//TR",
    opts.asInvite ? "METHOD:REQUEST" : "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${opts.uid}@donor-stream`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(startUtc)}`,
    `DTEND:${fmt(endUtc)}`,
    `SUMMARY:${opts.title}`,
    `DESCRIPTION:${opts.projectName} - Canlı yayın: ${opts.siteUrl}`,
    `LOCATION:${opts.siteUrl}`,
    "ORGANIZER;CN=Turk Kizilay:mailto:onboarding@resend.dev",
  ];
  if (opts.attendeeEmail) {
    lines.push(
      `ATTENDEE;CN=${opts.attendeeName || opts.attendeeEmail};RSVP=TRUE:mailto:${opts.attendeeEmail}`,
    );
  }
  lines.push("STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

function buildEventInviteHtml(opts: {
  name: string;
  projectName: string;
  eventDate: string;
  eventTime: string;
  siteUrl: string;
  eventId: number;
  displayDate: string;
  customMessage?: string | null;
  customClosing?: string | null;
  personalLink?: string | null;
}): string {
  const name = escapeHtml(opts.name);
  const project = escapeHtml(opts.projectName);
  const date = escapeHtml(opts.displayDate);
  const time = escapeHtml(opts.eventTime);
  const icsUrl = `${opts.siteUrl}api/events/${opts.eventId}/calendar.ics`;

  // Admin bir kalem ikonuyla anlatım metnini düzenlediyse onu kullan (kişiye özel [isim]
  // yer tutucusu desteklenir), aksi halde standart anlatım metni kullanılır. Tarih/saat/
  // Takvime Ekle butonu HER ZAMAN sabit kalır, bozulmaz.
  let bodyHtml: string;
  if (opts.customMessage && opts.customMessage.trim()) {
    const personalized = opts.customMessage.replace(
      /\[[iİıI][sS][iİıI][mM]\]/g,
      opts.name,
    );
    bodyHtml = `<p>${escapeHtml(personalized).replace(/\n/g, "<br>")}</p>`;
  } else {
    bodyHtml = `
    <p>Gerçekleştirmiş olduğunuz kıymetli bağışınızla ihtiyaç sahiplerine umut olan bir iyiliğin hayat bulmasına vesile oldunuz.</p>
    <p>Sizlerin desteğiyle hayata geçirilen <b>${project}</b> için gerçekleştireceğimiz açılış programında, bu anlamlı ana birlikte tanıklık etmekten büyük mutluluk duyacağız.</p>
    <p>Bu özel günde, iyiliğin somut bir esere ve kalıcı bir değere dönüşmesine katkı sağlayan siz değerli bağışçımızı da aramızda görmek isteriz.</p>`;
  }

  let closingHtml: string;
  if (opts.customClosing && opts.customClosing.trim()) {
    const personalized = opts.customClosing.replace(
      /\[[iİıI][sS][iİıI][mM]\]/g,
      opts.name,
    );
    closingHtml = `<p style="margin-top:24px;">${escapeHtml(personalized).replace(/\n/g, "<br>")}</p>`;
  } else {
    closingHtml = `
    <p style="margin-top:24px;">İyiliğin büyümesine ve daha fazla insana ulaşmasına sağladığınız değerli katkı için teşekkür ederiz.</p>
    <p>Saygılarımızla,<br/>Türk Kızılay</p>`;
  }

  return `
  <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 0 auto; color: #111;">
    <p>Değerli Bağışçımız ${name},</p>
    ${bodyHtml}
    <p style="margin-top:24px;"><b>Açılış Programı</b></p>
    <p style="margin:4px 0;">📅 Tarih: ${date}</p>
    <p style="margin:4px 0;">📍 <a href="${opts.personalLink || opts.siteUrl}">${opts.siteUrl}</a></p>
    <p style="margin:4px 0;">⏰ Saat: ${time}</p>
    <p style="margin-top:20px;">
      <a href="${icsUrl}" style="display:inline-block;background:#c10100;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;">🗓️ Takvime Ekle</a>
    </p>
    ${closingHtml}
  </div>`;
}

function buildEventStatusChangeHtml(opts: {
  name: string;
  title: string;
  projectName: string;
  status: "postponed" | "cancelled";
  note?: string | null;
}): string {
  const name = escapeHtml(opts.name);
  const title = escapeHtml(opts.title);
  const project = escapeHtml(opts.projectName);
  const note = opts.note ? escapeHtml(opts.note) : null;

  const headline =
    opts.status === "cancelled"
      ? `<b>${title}</b> etkinliği maalesef iptal edilmiştir.`
      : `<b>${title}</b> etkinliği ertelenmiştir. Yeni tarih belirlendiğinde ayrıca bilgilendirileceksiniz.`;

  return `
  <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 0 auto; color: #111;">
    <p>Değerli Bağışçımız ${name},</p>
    <p>${headline}</p>
    <p>Sizlerin desteğiyle hayata geçirilen <b>${project}</b> projesiyle ilgili bu değişiklik hakkında bilgi vermek istedik.</p>
    ${note ? `<p style="margin-top:16px; padding:12px 16px; background:#fdecec; border-radius:8px;"><b>Not:</b> ${note}</p>` : ""}
    <p style="margin-top:24px;">Anlayışınız için teşekkür eder, göstermiş olduğunuz destek için minnettarlığımızı bir kez daha belirtmek isteriz.</p>
    <p>Saygılarımızla,<br/>Türk Kızılay</p>
  </div>`;
}

function buildThankYouHtml(opts: {
  name: string;
  title: string;
  message: string;
  videoUrl?: string | null;
}): string {
  const personalized = opts.message.replace(
    /\[[iİıI][sS][iİıI][mM]\]/g,
    opts.name,
  );
  const message = escapeHtml(personalized).replace(/\n/g, "<br>");

  const videoButton = opts.videoUrl
    ? `<p style="margin-top:20px;">
         <a href="${escapeHtml(opts.videoUrl)}" style="display:inline-block;background:#c10100;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;">🎥 Yayın Kaydını İzle</a>
       </p>`
    : "";

  return `
  <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 0 auto; color: #111;">
    <p>${message}</p>
    ${videoButton}
  </div>`;
}

async function sendEventInviteToParticipant(
  c: any,
  event: {
    id: number;
    title: string;
    project_name: string;
    event_date: string;
    event_time: string;
    custom_invite_message?: string | null;
    custom_invite_closing?: string | null;
  },
  participant: { email: string; name: string },
  siteUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Her davet gönderiminde taze bir kişisel link üretilir (yeniden gönderimde eskisi geçersizleşir)
    const magicToken = generateMagicToken();
    await c.env.DB.prepare(
      "UPDATE event_participants SET magic_token = ? WHERE event_id = ? AND email = ?",
    )
      .bind(magicToken, event.id, participant.email)
      .run();
    const personalLink = `${siteUrl}e.html?t=${magicToken}`;

    const html = buildEventInviteHtml({
      name: participant.name,
      projectName: event.project_name,
      eventDate: event.event_date,
      eventTime: event.event_time,
      siteUrl,
      eventId: event.id,
      displayDate: formatDisplayDate(event.event_date),
      customMessage: event.custom_invite_message,
      customClosing: event.custom_invite_closing,
      personalLink,
    });

    const icsForAttachment = buildIcsContent({
      uid: `event-${event.id}`,
      title: event.title,
      projectName: event.project_name,
      eventDate: event.event_date,
      eventTime: event.event_time,
      siteUrl,
      attendeeEmail: participant.email,
      attendeeName: participant.name,
      asInvite: true,
    });
    const icsBase64 = btoa(unescape(encodeURIComponent(icsForAttachment)));

    await sendEmail(
      c.env,
      participant.email,
      `${event.title} - Açılış Programı Davetiniz`,
      html,
      [{ filename: "etkinlik.ics", content: icsBase64 }],
    );

    await c.env.DB.prepare(
      `UPDATE event_participants SET mail_sent = 1, sent_at = ? WHERE event_id = ? AND email = ?`,
    )
      .bind(Math.floor(Date.now() / 1000), event.id, participant.email)
      .run();

    return { ok: true };
  } catch (err: any) {
    const errMsg = err?.message || "Bilinmeyen hata";
    await c.env.DB.prepare(
      `UPDATE event_participants SET mail_error = ? WHERE event_id = ? AND email = ?`,
    )
      .bind(errMsg, event.id, participant.email)
      .run();
    return { ok: false, error: errMsg };
  }
}

const TR_CHAR_MAP: Record<string, string> = {
  ç: "c",
  Ç: "c",
  ğ: "g",
  Ğ: "g",
  ı: "i",
  İ: "i",
  ö: "o",
  Ö: "o",
  ş: "s",
  Ş: "s",
  ü: "u",
  Ü: "u",
};

function slugifyName(name: string): string {
  const converted = name
    .split("")
    .map((ch) => TR_CHAR_MAP[ch] ?? ch)
    .join("");
  const slug = converted
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
  return slug || "misafir";
}

function generateAccessCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Sihirli link için uzun, tahmin edilemez bir gizli token üretir (kişisel erişim için)
function generateMagicToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID())
    .replace(/-/g, "")
    .slice(0, 24);
}

// Mailli bağışçıların kişisel giriş linki, etkinlik tarihinden 2 gün sonra geçersiz olur —
// eski davet mailleri gelen kutusunda süresiz kalabildiği için bu bir güvenlik önlemi.
function isEventLinkExpired(eventDate: string): boolean {
  const [y, m, d] = eventDate.split("-").map(Number);
  if (!y || !m || !d) return true;
  const eventMidnightUTC = Date.UTC(y, m - 1, d);
  const expiryMs = eventMidnightUTC + 2 * 24 * 60 * 60 * 1000;
  return Date.now() > expiryMs;
}

// Etkinliğin planlanan başlangıç anını (Türkiye saatine göre) milisaniye olarak döndürür.
// Link, bu andan ÖNCE açılırsa erişim reddedilmez — geri sayım gösterilir. Bu sayede
// aynı gün birden fazla etkinlik varsa, biri diğerinin linkiyle erken girip "yanlış"
// yayını izleyemez; vakti gelmeden hiçbir yayına erişim verilmez.
function getEventStartMs(eventDate: string, eventTime: string): number {
  const [y, m, d] = eventDate.split("-").map(Number);
  const [hh, mm] = (eventTime || "00:00").split(":").map(Number);
  return Date.UTC(y, m - 1, d, (hh || 0) - 3, mm || 0); // Türkiye UTC+3 -> UTC
}

// Bir etkinlik için GRUP giriş kodu oluşturur (ya da zaten varsa onu döndürür).
// Bu kod, farklı kişilerce paylaşılıp kullanılabilir — kişiye özel değildir.
async function ensureGroupAccessForEvent(
  db: D1Database,
  eventId: number,
  eventTitle: string,
): Promise<{ username: string; code: string }> {
  const existing = (await db
    .prepare("SELECT username, code FROM event_group_access WHERE event_id = ?")
    .bind(eventId)
    .first()) as { username: string; code: string } | null;
  if (existing) return existing;

  const baseUsername = slugifyName(eventTitle);
  let username = baseUsername;
  let suffix = 2;
  for (let i = 0; i < 20; i++) {
    const exists = await db
      .prepare("SELECT username FROM event_group_access WHERE username = ?")
      .bind(username)
      .first();
    if (!exists) break;
    username = baseUsername + suffix;
    suffix++;
  }

  const code = generateAccessCode();
  await db
    .prepare(
      "INSERT INTO event_group_access (event_id, username, code) VALUES (?, ?, ?)",
    )
    .bind(eventId, username, code)
    .run();

  return { username, code };
}

function buildGroupAccessNotificationHtml(opts: {
  eventTitle: string;
  projectName: string;
  displayDate: string;
  eventTime: string;
  username: string;
  code: string;
  siteUrl: string;
}): string {
  const title = escapeHtml(opts.eventTitle);
  const project = escapeHtml(opts.projectName);
  const date = escapeHtml(opts.displayDate);
  const time = escapeHtml(opts.eventTime);
  return `
  <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 0 auto; color: #111;">
    <p>Yeni bir etkinlik planlandı: <b>${title}</b> (${project})</p>
    <p>📅 ${date} · ⏰ ${time}</p>
    <p>Katılmasını istediğiniz, sistemde henüz kaydı olmayan bağışçılarınızla aşağıdaki bilgileri paylaşabilirsiniz. Bu kod <b>birden fazla kişi tarafından</b> kullanılabilir — her biri giriş yaparken kendi adını gireceği için sistemde ayrı ayrı görünürler.</p>
    <p style="margin-top:16px; padding:14px 18px; background:#faf9f7; border-radius:8px;">
      <b>Kullanıcı adı:</b> ${escapeHtml(opts.username)}<br/>
      <b>Kod:</b> ${escapeHtml(opts.code)}
    </p>
    <p style="margin-top:16px;">Katılmak isteyenler <a href="${opts.siteUrl}">${opts.siteUrl}</a> adresinden "Kullanıcı adı ile giriş" seçeneğini kullanıp bu bilgileri (ve kendi adlarını) girerek katılabilirler.</p>
  </div>`;
}

// Grup kodunu HER ZAMAN üretir (mail ayarlı olsun olmasın) — admin panelinde
// her zaman görünsün diye. Mail gönderimi ayrı bir adım (aşağıdaki fonksiyon).
async function ensureAndNotifyGroupAccess(
  c: any,
  event: {
    id: number;
    title: string;
    project_name: string;
    event_date: string;
    event_time: string;
  },
): Promise<{ username: string; code: string } | null> {
  let access: { username: string; code: string } | null = null;
  try {
    access = await ensureGroupAccessForEvent(c.env.DB, event.id, event.title);
  } catch (err: any) {
    console.error("Grup kodu üretilemedi (asıl akış etkilenmedi):", err);
    return null;
  }

  // Grup bildirim maili ayarlıysa gönder — bu adımın başarısız olması asıl
  // bağışçı davet mailini ASLA etkilemesin diye ayrıca try/catch içinde.
  try {
    const settingRow = (await c.env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'group_notification_email'",
    ).first()) as { value: string } | null;
    const groupEmail = settingRow?.value?.trim();
    if (!groupEmail) return access;

    const siteUrl = new URL(c.req.url).origin + "/";
    const html = buildGroupAccessNotificationHtml({
      eventTitle: event.title,
      projectName: event.project_name,
      displayDate: formatDisplayDate(event.event_date),
      eventTime: event.event_time,
      username: access.username,
      code: access.code,
      siteUrl,
    });
    await sendEmail(
      c.env,
      groupEmail,
      `${event.title} - Grup Giriş Kodu`,
      html,
    );
  } catch (err: any) {
    console.error(
      "Grup bildirim maili gönderilemedi (asıl akış etkilenmedi):",
      err,
    );
  }

  return access;
}

// ---------- Bağışçı girişi (OTP) ----------

app.post("/api/send-otp", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = body?.email ? normalizeEmail(body.email) : null;
  if (!email || !email.includes("@")) {
    return c.json({ ok: false, error: "Geçerli bir e-posta girin." }, 400);
  }

  const donor = await c.env.DB.prepare(
    `SELECT email FROM allowed_donors WHERE email = ? AND (
       is_permanent = 1
       OR EXISTS (
         SELECT 1 FROM event_participants ep JOIN events ev ON ev.id = ep.event_id
         WHERE ep.email = allowed_donors.email
         AND date(ev.event_date, '+2 days') >= date('now')
       )
     )`,
  )
    .bind(email)
    .first();

  // Bilgi sızdırmamak için kayıtlı olmasa (ya da erişimi kapanmış olsa) bile "ok" dönüyoruz
  if (!donor) return c.json({ ok: true });

  const code = generateOtpCode();
  const codeHash = await sha256Hex(code);
  const expiresAt = Math.floor(Date.now() / 1000) + OTP_TTL_SECONDS;

  await c.env.DB.prepare(
    `INSERT INTO otp_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
  )
    .bind(email, codeHash, expiresAt)
    .run();

  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <p>Türk Kızılay Bağışçı Canlı Yayın Platformu giriş kodunuz:</p>
      <p style="font-size: 32px; font-weight: 700; letter-spacing: 4px;">${code}</p>
      <p style="color:#666; font-size: 13px;">Bu kod 10 dakika geçerlidir.</p>
    </div>`;
  await sendEmail(c.env, email, "Giriş Kodunuz", html);

  return c.json({ ok: true });
});

app.post("/api/verify-otp", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = body?.email ? normalizeEmail(body.email) : null;
  const code: string | undefined = body?.code;
  const kvkkAccepted = body?.kvkkAccepted === true;

  if (!email || !code)
    return c.json({ ok: false, error: "E-posta ve kod gerekli." }, 400);
  if (!kvkkAccepted)
    return c.json(
      { ok: false, error: "KVKK metnini onaylamanız gerekiyor." },
      400,
    );

  const row = (await c.env.DB.prepare(
    "SELECT code_hash, expires_at, attempts FROM otp_codes WHERE email = ?",
  )
    .bind(email)
    .first()) as {
    code_hash: string;
    expires_at: number;
    attempts: number;
  } | null;

  if (!row) {
    return c.json({ ok: false, error: "Kod bulunamadı, tekrar isteyin." }, 400);
  }
  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    return c.json(
      { ok: false, error: "Kodun süresi doldu, tekrar isteyin." },
      400,
    );
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    return c.json(
      { ok: false, error: "Çok fazla hatalı deneme, tekrar kod isteyin." },
      400,
    );
  }

  const codeHash = await sha256Hex(code);
  if (codeHash !== row.code_hash) {
    await c.env.DB.prepare(
      "UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ?",
    )
      .bind(email)
      .run();
    return c.json({ ok: false, error: "Kod hatalı." }, 400);
  }

  // Kod gönderildikten sonra (10 dk içinde) erişim penceresi kapanmış olabilir —
  // oturum açmadan hemen önce son bir kez kontrol ediyoruz.
  const stillActive = await c.env.DB.prepare(
    `SELECT email FROM allowed_donors WHERE email = ? AND (
       is_permanent = 1
       OR EXISTS (
         SELECT 1 FROM event_participants ep JOIN events ev ON ev.id = ep.event_id
         WHERE ep.email = allowed_donors.email
         AND date(ev.event_date, '+2 days') >= date('now')
       )
     )`,
  )
    .bind(email)
    .first();
  if (!stillActive) {
    return c.json(
      {
        ok: false,
        error: "Erişim süreniz dolmuş. Yöneticinizle iletişime geçin.",
      },
      403,
    );
  }

  await c.env.DB.prepare("DELETE FROM otp_codes WHERE email = ?")
    .bind(email)
    .run();
  await c.env.DB.prepare(
    "INSERT INTO kvkk_consents (email, accepted_at) VALUES (?, ?)",
  )
    .bind(email, Math.floor(Date.now() / 1000))
    .run();

  // İzleme süresi raporunda doğru etkinliğe yazılsın diye, bu bağışçının hâlâ
  // aktif penceresi açık olan en güncel etkinliğini bul (yoksa süresiz demektir).
  const activeEvent = (await c.env.DB.prepare(
    `SELECT ep.event_id AS eventId FROM event_participants ep
     JOIN events ev ON ev.id = ep.event_id
     WHERE ep.email = ? AND date(ev.event_date, '+2 days') >= date('now')
     ORDER BY ev.event_date DESC LIMIT 1`,
  )
    .bind(email)
    .first()) as { eventId: number } | null;

  await createSessionAndSetCookie(c, email, activeEvent?.eventId ?? null);
  return c.json({ ok: true });
});

// E-postası olmayan bağışçılar için: kullanıcı adı + kod ile giriş
// GRUP giriş kodu ile giriş (birden fazla farklı kişi aynı kodu kullanabilir, her biri
// kendi adını girer). Kişisel erişim artık sihirli link (/api/magic-login) ile yapılıyor.
app.post("/api/manual-login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const username: string | undefined = body?.username?.trim();
  const code: string | undefined = body?.code?.trim();
  const name: string | undefined = body?.name?.trim();
  const kvkkAccepted = body?.kvkkAccepted === true;

  if (!username || !code)
    return c.json({ ok: false, error: "Kullanıcı adı ve kod gerekli." }, 400);
  if (!kvkkAccepted)
    return c.json(
      { ok: false, error: "KVKK metnini onaylamanız gerekiyor." },
      400,
    );

  const groupRow = (await c.env.DB.prepare(
    `SELECT ega.event_id, ega.username, ega.code, ev.event_date
     FROM event_group_access ega JOIN events ev ON ev.id = ega.event_id
     WHERE ega.username = ?`,
  )
    .bind(username)
    .first()) as {
    event_id: number;
    username: string;
    code: string;
    event_date: string;
  } | null;

  if (!groupRow || groupRow.code !== code) {
    return c.json({ ok: false, error: "Kullanıcı adı veya kod hatalı." }, 400);
  }

  if (isEventLinkExpired(groupRow.event_date)) {
    return c.json(
      {
        ok: false,
        error: "Bu kodun süresi dolmuş. Yöneticinizle iletişime geçin.",
      },
      403,
    );
  }

  if (!name) {
    return c.json(
      {
        ok: false,
        nameRequired: true,
        error:
          "Bu, paylaşılan bir grup kodu — lütfen adınızı soyadınızı da girin.",
      },
      400,
    );
  }

  // Aynı grup kodunu kullanan farklı kişileri birbirinden ayırmak için her girişte
  // benzersiz bir sentetik e-posta üretiyoruz (isim aynı olsa bile çakışmaz)
  const syntheticEmail = `${username}-${crypto.randomUUID().slice(0, 8)}@manual.donor`;

  await c.env.DB.prepare(
    `INSERT INTO allowed_donors (email, name, is_permanent) VALUES (?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name`,
  )
    .bind(syntheticEmail, name)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO event_participants (event_id, email, name, mail_sent) VALUES (?, ?, ?, 1)`,
  )
    .bind(groupRow.event_id, syntheticEmail, name)
    .run();

  await c.env.DB.prepare(
    "INSERT INTO kvkk_consents (email, accepted_at) VALUES (?, ?)",
  )
    .bind(syntheticEmail, Math.floor(Date.now() / 1000))
    .run();

  await createSessionAndSetCookie(c, syntheticEmail, groupRow.event_id);
  return c.json({ ok: true });
});

const DEVICE_COOKIE_MAX_AGE = 399 * 24 * 60 * 60; // 399 gün — tarayıcıların izin verdiği 400 günlük sınırın hemen altında, "süresiz" gibi davranır

// Sihirli link durumunu (kullanılabilir mi, bu cihaza mı kilitli, başka cihaza mı kilitli)
// KVKK onayı istemeden önce kontrol eder — böylece boşuna onay verip hata almasınlar.
app.get("/api/magic-login/check", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ ok: false, status: "invalid" });

  const row = (await c.env.DB.prepare(
    `SELECT ma.bound_device_id, ma.name, ma.event_id, ev.title AS event_title, ev.event_date, ev.event_time
     FROM manual_access ma LEFT JOIN events ev ON ev.id = ma.event_id
     WHERE ma.code = ?`,
  )
    .bind(code)
    .first()) as {
    bound_device_id: string | null;
    name: string;
    event_id: number | null;
    event_title: string | null;
    event_date: string | null;
    event_time: string | null;
  } | null;

  if (!row) return c.json({ ok: true, status: "invalid" });

  // Bir etkinliğe bağlıysa (Etkinlik Planlama'dan "E-postası yok" ile eklenmişse), o
  // etkinliğin süre/geri sayım kuralları geçerli. Standalone (süresiz) kartlardan
  // oluşturulanlarda event_id NULL'dur, bu kontroller hiç uygulanmaz.
  if (row.event_id && row.event_date) {
    if (isEventLinkExpired(row.event_date))
      return c.json({ ok: true, status: "expired" });
    const startMs = getEventStartMs(row.event_date, row.event_time || "00:00");
    if (Date.now() < startMs) {
      return c.json({
        ok: true,
        status: "countdown",
        eventTitle: row.event_title,
        eventStartMs: startMs,
      });
    }
  }

  if (!row.bound_device_id) {
    return c.json({ ok: true, status: "available", name: row.name });
  }

  const deviceCookie = getCookie(c, "mv_device");
  if (deviceCookie && deviceCookie === row.bound_device_id) {
    return c.json({ ok: true, status: "bound-this-device", name: row.name });
  }
  return c.json({ ok: true, status: "bound-other-device", name: row.name });
});

// Sihirli linkin asıl giriş adımı — ilk başarılı girişte cihaza kilitlenir
app.post("/api/magic-login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const code: string | undefined = body?.code?.trim();
  const kvkkAccepted = body?.kvkkAccepted === true;

  if (!code) return c.json({ ok: false, error: "Geçersiz link." }, 400);
  if (!kvkkAccepted)
    return c.json(
      { ok: false, error: "KVKK metnini onaylamanız gerekiyor." },
      400,
    );

  const row = (await c.env.DB.prepare(
    `SELECT ma.username, ma.name, ma.synthetic_email, ma.bound_device_id, ma.event_id, ev.event_date, ev.event_time
     FROM manual_access ma LEFT JOIN events ev ON ev.id = ma.event_id
     WHERE ma.code = ?`,
  )
    .bind(code)
    .first()) as {
    username: string;
    name: string;
    synthetic_email: string;
    bound_device_id: string | null;
    event_id: number | null;
    event_date: string | null;
    event_time: string | null;
  } | null;

  if (!row) return c.json({ ok: false, error: "Geçersiz link." }, 400);

  if (row.event_id && row.event_date) {
    if (isEventLinkExpired(row.event_date)) {
      return c.json(
        {
          ok: false,
          error: "Bu linkin süresi dolmuş. Yöneticinizle iletişime geçin.",
        },
        403,
      );
    }
    if (
      Date.now() < getEventStartMs(row.event_date, row.event_time || "00:00")
    ) {
      return c.json({ ok: false, error: "Yayın henüz başlamadı." }, 403);
    }
  }

  let deviceId = getCookie(c, "mv_device");
  if (!deviceId) deviceId = crypto.randomUUID();

  if (row.bound_device_id) {
    if (row.bound_device_id !== deviceId) {
      return c.json(
        {
          ok: false,
          error:
            "Bu link başka bir cihazda kullanılmış. Yeni bir link için yöneticinizle iletişime geçin.",
        },
        403,
      );
    }
  } else {
    await c.env.DB.prepare(
      "UPDATE manual_access SET bound_device_id = ? WHERE code = ?",
    )
      .bind(deviceId, code)
      .run();
  }

  setCookie(c, "mv_device", deviceId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE,
  });

  await c.env.DB.prepare(
    "INSERT INTO kvkk_consents (email, accepted_at) VALUES (?, ?)",
  )
    .bind(row.synthetic_email, Math.floor(Date.now() / 1000))
    .run();

  await createSessionAndSetCookie(c, row.synthetic_email, row.event_id);
  return c.json({ ok: true });
});

// Admin, bir bağışçının cihaz kilidini sıfırlayabilir (örn. telefon değiştiyse)
app.post("/api/admin/manual-access/:username/reset-device", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const username = c.req.param("username");
  await c.env.DB.prepare(
    "UPDATE manual_access SET bound_device_id = NULL WHERE username = ?",
  )
    .bind(username)
    .run();
  return c.json({ ok: true });
});

// ---------- Mailli bağışçıların kişisel etkinlik linki (e.html) ----------

app.get("/api/event-login/check", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ ok: true, status: "invalid" });

  const row = (await c.env.DB.prepare(
    `SELECT ep.name, ep.bound_device_id, ev.title, ev.event_date, ev.event_time
     FROM event_participants ep JOIN events ev ON ev.id = ep.event_id
     WHERE ep.magic_token = ?`,
  )
    .bind(token)
    .first()) as {
    name: string | null;
    bound_device_id: string | null;
    title: string;
    event_date: string;
    event_time: string;
  } | null;

  if (!row) return c.json({ ok: true, status: "invalid" });
  if (isEventLinkExpired(row.event_date))
    return c.json({ ok: true, status: "expired" });

  const startMs = getEventStartMs(row.event_date, row.event_time);
  if (Date.now() < startMs) {
    return c.json({
      ok: true,
      status: "countdown",
      eventTitle: row.title,
      eventStartMs: startMs,
    });
  }

  if (!row.bound_device_id) {
    return c.json({
      ok: true,
      status: "available",
      name: row.name,
      eventTitle: row.title,
    });
  }
  const deviceCookie = getCookie(c, "mv_device");
  if (deviceCookie && deviceCookie === row.bound_device_id) {
    return c.json({
      ok: true,
      status: "bound-this-device",
      name: row.name,
      eventTitle: row.title,
    });
  }
  return c.json({
    ok: true,
    status: "bound-other-device",
    name: row.name,
    eventTitle: row.title,
  });
});

app.post("/api/event-login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const token: string | undefined = body?.token?.trim();
  const kvkkAccepted = body?.kvkkAccepted === true;

  if (!token) return c.json({ ok: false, error: "Geçersiz link." }, 400);
  if (!kvkkAccepted)
    return c.json(
      { ok: false, error: "KVKK metnini onaylamanız gerekiyor." },
      400,
    );

  const row = (await c.env.DB.prepare(
    `SELECT ep.email, ep.event_id, ep.bound_device_id, ev.event_date, ev.event_time
     FROM event_participants ep JOIN events ev ON ev.id = ep.event_id
     WHERE ep.magic_token = ?`,
  )
    .bind(token)
    .first()) as {
    email: string;
    event_id: number;
    bound_device_id: string | null;
    event_date: string;
    event_time: string;
  } | null;

  if (!row) return c.json({ ok: false, error: "Geçersiz link." }, 400);
  if (isEventLinkExpired(row.event_date)) {
    return c.json(
      {
        ok: false,
        error: "Bu linkin süresi dolmuş. Yöneticinizle iletişime geçin.",
      },
      403,
    );
  }
  if (Date.now() < getEventStartMs(row.event_date, row.event_time)) {
    return c.json({ ok: false, error: "Yayın henüz başlamadı." }, 403);
  }

  let deviceId = getCookie(c, "mv_device");
  if (!deviceId) deviceId = crypto.randomUUID();

  if (row.bound_device_id) {
    if (row.bound_device_id !== deviceId) {
      return c.json(
        {
          ok: false,
          error:
            "Bu link başka bir cihazda kullanılmış. Yeni bir link için yöneticinizle iletişime geçin.",
        },
        403,
      );
    }
  } else {
    await c.env.DB.prepare(
      "UPDATE event_participants SET bound_device_id = ? WHERE magic_token = ?",
    )
      .bind(deviceId, token)
      .run();
  }

  setCookie(c, "mv_device", deviceId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE,
  });

  await c.env.DB.prepare(
    "INSERT INTO kvkk_consents (email, accepted_at) VALUES (?, ?)",
  )
    .bind(row.email, Math.floor(Date.now() / 1000))
    .run();

  await createSessionAndSetCookie(c, row.email, row.event_id);
  return c.json({ ok: true });
});

app.post("/api/logout", async (c) => {
  const token = getCookie(c, "session");
  if (token) {
    const tokenHash = await sha256Hex(token);
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(tokenHash)
      .run();
  }
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const email = await requireSession(c);
  if (!email) return c.json({ ok: false }, 401);
  const donor = await c.env.DB.prepare(
    "SELECT name FROM allowed_donors WHERE email = ?",
  )
    .bind(email)
    .first<{ name: string | null }>();
  return c.json({
    ok: true,
    email,
    name: donor?.name || email,
    streamCustomerCode: c.env.STREAM_CUSTOMER_CODE,
    liveInputUid: c.env.STREAM_LIVE_INPUT_UID,
  });
});

// Yayın sonrası memnuniyet anketi
app.post("/api/feedback", async (c) => {
  const email = await requireSession(c);
  if (!email) return c.json({ ok: false, error: "Yetkisiz." }, 401);

  const body = await c.req.json().catch(() => null);
  const rating: number | null =
    typeof body?.rating === "number" && body.rating >= 1 && body.rating <= 5
      ? body.rating
      : null;
  const systemFeedback: string | null = body?.systemFeedback?.trim() || null;
  const personalFeedback: string | null =
    body?.personalFeedback?.trim() || null;

  // Hiçbir alan doldurulmadıysa (yıldız verilmedi, iki metin kutusu da boş) veritabanına
  // boş bir kayıt eklemiyoruz — gereksiz veri kirliliği olmasın diye.
  if (rating === null && !systemFeedback && !personalFeedback) {
    return c.json({ ok: true, skipped: true });
  }

  await c.env.DB.prepare(
    `INSERT INTO feedback (email, rating, system_feedback, personal_feedback) VALUES (?, ?, ?, ?)`,
  )
    .bind(email, rating, systemFeedback, personalFeedback)
    .run();

  return c.json({ ok: true });
});

// ---------- Takvim (.ics) indirme — herkese açık ----------

app.get("/api/events/:id/calendar.ics", async (c) => {
  const eventId = c.req.param("id");
  const event = (await c.env.DB.prepare(
    "SELECT id, title, project_name, event_date, event_time FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first()) as {
    id: number;
    title: string;
    project_name: string;
    event_date: string;
    event_time: string;
  } | null;

  if (!event) return c.text("Etkinlik bulunamadı", 404);

  const siteUrl = new URL(c.req.url).origin + "/";
  const ics = buildIcsContent({
    uid: `event-${event.id}`,
    title: event.title,
    projectName: event.project_name,
    eventDate: event.event_date,
    eventTime: event.event_time,
    siteUrl,
  });

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="etkinlik.ics"`,
    },
  });
});

// ---------- Moderatör oturumu ----------

app.post("/api/moderator/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const password: string | undefined = body?.password;
  if (!password) return c.json({ ok: false, error: "Şifre gerekli." }, 400);

  const row = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'moderator_password_hash'",
  ).first<{ value: string }>();
  if (!row)
    return c.json(
      { ok: false, error: "Moderatör şifresi henüz ayarlanmamış." },
      400,
    );

  const passwordHash = await sha256Hex(password);
  if (passwordHash !== row.value)
    return c.json({ ok: false, error: "Şifre hatalı." }, 401);

  const modToken = crypto.randomUUID() + crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('mod_session_token', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(modToken)
    .run();

  setCookie(c, "mod_session", modToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 12 * 60 * 60,
  });

  return c.json({ ok: true });
});

app.get("/api/moderator/me", async (c) => {
  const ok = await requireModerator(c);
  if (!ok) return c.text("Yetkisiz", 401);
  return c.json({ ok: true });
});

// ---------- Moderatör odası (WebSocket relay) ----------

app.get("/api/room/ws", async (c) => {
  const role = c.req.query("role") === "moderator" ? "moderator" : "viewer";

  let email: string | null = null;
  let eventId: number | null = null;

  if (role === "moderator") {
    const ok = await requireModerator(c);
    if (!ok) return c.text("Yetkisiz", 401);
  } else {
    const session = await requireSessionWithEvent(c);
    if (!session) return c.text("Yetkisiz", 401);
    email = session.email;
    eventId = session.eventId;
  }

  let name: string | null = null;
  if (email) {
    const donor = (await c.env.DB.prepare(
      "SELECT name FROM allowed_donors WHERE email = ?",
    )
      .bind(email)
      .first()) as { name: string | null } | null;
    name = donor?.name || email;
  }

  const id = c.env.MODERATOR_ROOM.idFromName("main-room");
  const stub = c.env.MODERATOR_ROOM.get(id);

  const url = new URL(c.req.url);
  url.pathname = "/ws";
  url.searchParams.set("role", role);
  if (email) url.searchParams.set("email", email);
  if (name) url.searchParams.set("name", name);
  if (eventId !== null) url.searchParams.set("eventId", String(eventId));

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// ---------- Cloudflare Realtime (mikrofon/kamera WebRTC) proxy ----------

// Cloudflare Realtime API'sine güvenli bir istek atar; JSON olmayan yanıtlarda
// (örn. "Internal Server Error" düz metni) anlamlı bir hata döndürür.
async function callRealtimeApi(
  env: Bindings,
  path: string,
  method: string,
  body?: any,
): Promise<{ ok: boolean; status: number; data?: any; errorText?: string }> {
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/apps/${env.CF_REALTIME_APP_ID}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${env.CF_REALTIME_APP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
  );
  const rawText = await res.text();
  try {
    const data = JSON.parse(rawText);
    if (!res.ok) {
      console.error(
        `[Realtime API hatası] ${method} ${path} -> ${res.status}`,
        JSON.stringify(body),
        "yanıt:",
        rawText,
      );
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    console.error(
      `Cloudflare Realtime API JSON olmayan yanıt (${method} ${path}):`,
      res.status,
      "gönderilen body:",
      JSON.stringify(body),
      "yanıt:",
      rawText,
    );
    return { ok: false, status: res.status, errorText: rawText.slice(0, 300) };
  }
}

// Yayıncı (mikrofon/kamera isteyen bağışçı) tarafı: Cloudflare Realtime API'si iki
// adım gerektiriyor — önce boş bir oturum oluşturulur, sonra o oturuma track (SDP teklifiyle
// birlikte) eklenir. Eskiden tek adımda, var olmayan bir endpoint'e istek atılıyordu
// ("405 reserved for future WHIP/WHEP" hatasının kaynağı buydu).
app.post("/api/realtime/publish", async (c) => {
  const email = await requireSession(c);
  if (!email) return c.json({ ok: false, error: "Yetkisiz." }, 401);

  const body = await c.req.json();

  // 1. Adım: boş bir oturum oluştur
  const sessionResult = await callRealtimeApi(
    c.env,
    "/sessions/new",
    "POST",
    undefined,
  );
  if (!sessionResult.ok || !sessionResult.data?.sessionId) {
    return c.json(
      {
        ok: false,
        error:
          sessionResult.errorText ||
          sessionResult.data?.errorDescription ||
          "Oturum oluşturulamadı.",
      },
      502,
    );
  }
  const sessionId = sessionResult.data.sessionId;

  // 2. Adım: o oturuma, teklif (offer) SDP'siyle birlikte track ekle
  const trackResult = await callRealtimeApi(
    c.env,
    `/sessions/${sessionId}/tracks/new`,
    "POST",
    {
      sessionDescription: { sdp: body.sdp, type: "offer" },
      tracks: body.tracks,
    },
  );
  if (!trackResult.ok) {
    return c.json(
      {
        ok: false,
        error:
          trackResult.errorText ||
          trackResult.data?.errorDescription ||
          "Track eklenemedi.",
      },
      502,
    );
  }

  return c.json({
    ok: true,
    data: {
      sessionId,
      sessionDescription: trackResult.data.sessionDescription,
      tracks: trackResult.data.tracks,
    },
  });
});

// İzleyici tarafı: iki farklı amaçla çağrılıyor —
// (a) viewerSessionId YOKSA: ilk kez bir izleyici oturumu kur (bootstrap)
// (b) viewerSessionId VARSA: o oturuma, belirli bir yayıncının track'ini "uzaktan" ekle
app.post("/api/realtime/pull", async (c) => {
  const email = await requireSession(c);
  if (!email) return c.json({ ok: false, error: "Yetkisiz." }, 401);

  const body = await c.req.json();
  const { viewerSessionId, remoteSessionId, remoteTrackName, sdp } = body;

  if (!viewerSessionId) {
    // (a) İzleyici oturumu kurulumu — tek adımda, teklif SDP'siyle birlikte oturum oluşturuluyor
    const result = await callRealtimeApi(c.env, "/sessions/new", "POST", {
      sessionDescription: { sdp, type: "offer" },
    });
    if (!result.ok || !result.data?.sessionId) {
      return c.json(
        {
          ok: false,
          error:
            result.errorText ||
            result.data?.errorDescription ||
            "İzleyici oturumu oluşturulamadı.",
        },
        502,
      );
    }
    return c.json({
      ok: true,
      sessionId: result.data.sessionId,
      data: {
        sessionId: result.data.sessionId,
        sessionDescription: result.data.sessionDescription,
      },
    });
  }

  // (b) Belirli bir yayıncının track'ini bu izleyici oturumuna ekle
  const result = await callRealtimeApi(
    c.env,
    `/sessions/${viewerSessionId}/tracks/new`,
    "POST",
    {
      tracks: [
        {
          location: "remote",
          sessionId: remoteSessionId,
          trackName: remoteTrackName,
        },
      ],
    },
  );
  if (!result.ok) {
    return c.json(
      {
        ok: false,
        error:
          result.errorText ||
          result.data?.errorDescription ||
          "Track çekilemedi.",
      },
      502,
    );
  }
  return c.json({ ok: true, data: result.data });
});

app.post("/api/realtime/renegotiate", async (c) => {
  const email = await requireSession(c);
  if (!email) return c.json({ ok: false, error: "Yetkisiz." }, 401);

  const body = await c.req.json();
  const { sessionId, sdp } = body;

  const result = await callRealtimeApi(
    c.env,
    `/sessions/${sessionId}/renegotiate`,
    "PUT",
    {
      sessionDescription: { sdp, type: "answer" },
    },
  );
  if (!result.ok) {
    return c.json(
      {
        ok: false,
        error:
          result.errorText ||
          result.data?.errorDescription ||
          "Yeniden görüşme başarısız.",
      },
      502,
    );
  }
  return c.json({ ok: true, data: result.data });
});

app.get("/api/stream-config", async (c) => {
  const email = await requireSession(c);
  if (!email) return c.json({ ok: false }, 401);
  return c.json({
    ok: true,
    customerCode: c.env.STREAM_CUSTOMER_CODE,
    liveInputUid: c.env.STREAM_LIVE_INPUT_UID,
  });
});

// ---------- Admin: bağışçı yönetimi ----------

app.get("/api/admin/donors", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const { results } = await c.env.DB.prepare(
    "SELECT email, name FROM allowed_donors WHERE is_permanent = 1 ORDER BY added_at DESC",
  ).all();
  return c.json({ ok: true, donors: results });
});

app.post("/api/admin/upload", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const body = await c.req.json().catch(() => null);
  const csv: string | undefined = body?.csv;
  if (!csv || !csv.trim())
    return c.json({ ok: false, error: "Veri boş." }, 400);

  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let inserted = 0;
  const errors: string[] = [];

  for (const line of lines) {
    const [rawEmail, rawName] = line.split(",");
    const email = normalizeEmail(rawEmail || "");
    if (!email || !email.includes("@")) {
      errors.push(`Geçersiz satır: "${line}"`);
      continue;
    }
    await c.env.DB.prepare(
      `INSERT INTO allowed_donors (email, name, is_permanent) VALUES (?, ?, 1)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, is_permanent = 1`,
    )
      .bind(email, rawName?.trim() || null)
      .run();
    inserted++;
  }

  return c.json({ ok: true, inserted, errors });
});

app.post("/api/admin/remove", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const body = await c.req.json().catch(() => null);
  const email = body?.email ? normalizeEmail(body.email) : null;
  if (!email) return c.json({ ok: false, error: "E-posta gerekli." }, 400);
  await c.env.DB.prepare("DELETE FROM allowed_donors WHERE email = ?")
    .bind(email)
    .run();
  return c.json({ ok: true });
});

// ---------- Manuel erişim (e-postası olmayan bağışçılar için) ----------

// E-postası olmayan bir bağışçı için sihirli link (kullanıcı adı + gizli token) oluşturur.
// Hem standalone "E-postası Olmayan Bağışçılar" ekranında hem de etkinlik planlamada
// "E-postası yok" seçeneğinde kullanılıyor.
async function createManualAccessForName(
  db: D1Database,
  siteUrl: string,
  name: string,
  eventId?: number | null,
): Promise<{
  username: string;
  code: string;
  syntheticEmail: string;
  link: string;
}> {
  const baseUsername = slugifyName(name);
  let username = baseUsername;
  let suffix = 2;
  for (let i = 0; i < 20; i++) {
    const exists = await db
      .prepare("SELECT username FROM manual_access WHERE username = ?")
      .bind(username)
      .first();
    if (!exists) break;
    username = baseUsername + suffix;
    suffix++;
  }

  const code = generateMagicToken();
  const syntheticEmail = `${username}@manual.donor`;
  const isPermanent = eventId ? 0 : 1;

  await db
    .prepare(
      "INSERT INTO manual_access (username, code, name, synthetic_email, event_id) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(username, code, name, syntheticEmail, eventId || null)
    .run();

  await db
    .prepare(
      isPermanent
        ? `INSERT INTO allowed_donors (email, name, is_permanent) VALUES (?, ?, 1)
           ON CONFLICT(email) DO UPDATE SET name = excluded.name, is_permanent = 1`
        : `INSERT INTO allowed_donors (email, name, is_permanent) VALUES (?, ?, 0)
           ON CONFLICT(email) DO UPDATE SET name = excluded.name`,
    )
    .bind(syntheticEmail, name)
    .run();

  const link = `${siteUrl}g.html?c=${code}`;
  return { username, code, syntheticEmail, link };
}

app.post("/api/admin/manual-access/create", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const body = await c.req.json().catch(() => null);
  const name: string = body?.name?.trim() || "İsimsiz Bağışçı";
  const siteUrl = new URL(c.req.url).origin + "/";

  const { username, code, link } = await createManualAccessForName(
    c.env.DB,
    siteUrl,
    name,
  );

  return c.json({ ok: true, username, code, name, link });
});

app.get("/api/admin/manual-access", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const { results } = await c.env.DB.prepare(
    "SELECT username, code, name, bound_device_id, created_at FROM manual_access WHERE event_id IS NULL ORDER BY created_at DESC",
  ).all();
  const siteUrl = new URL(c.req.url).origin + "/";
  const accounts = (results as any[]).map((r) => ({
    username: r.username,
    name: r.name,
    created_at: r.created_at,
    link: `${siteUrl}g.html?c=${r.code}`,
    used: !!r.bound_device_id,
  }));
  return c.json({ ok: true, accounts });
});

app.post("/api/admin/manual-access/remove", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const body = await c.req.json().catch(() => null);
  const username: string | undefined = body?.username;
  if (!username)
    return c.json({ ok: false, error: "Kullanıcı adı gerekli." }, 400);

  const row = (await c.env.DB.prepare(
    "SELECT synthetic_email FROM manual_access WHERE username = ?",
  )
    .bind(username)
    .first()) as { synthetic_email: string } | null;

  await c.env.DB.prepare("DELETE FROM manual_access WHERE username = ?")
    .bind(username)
    .run();
  if (row) {
    await c.env.DB.prepare("DELETE FROM allowed_donors WHERE email = ?")
      .bind(row.synthetic_email)
      .run();
  }
  return c.json({ ok: true });
});

// ---------- Etkinlik planlama ----------

app.post("/api/admin/events/create-and-send", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);

  const body = await c.req.json().catch(() => null);
  const title: string | undefined = body?.title?.trim();
  const projectName: string | undefined = body?.projectName?.trim();
  const eventDate: string | undefined = body?.eventDate?.trim();
  const eventTime: string | undefined = body?.eventTime?.trim();
  const csv: string | undefined = body?.csv;
  const noEmailNames: string[] = Array.isArray(body?.noEmailNames)
    ? body.noEmailNames
        .map((n: any) => String(n).trim())
        .filter((n: string) => n.length > 0)
    : [];
  const asDraft: boolean = body?.asDraft === true;
  const customMessage: string | null = body?.customMessage?.trim() || null;
  const customClosing: string | null = body?.customClosing?.trim() || null;

  if (!title || !projectName || !eventDate || !eventTime) {
    return c.json(
      {
        ok: false,
        error: "Etkinlik başlığı, proje adı, tarih ve saat gerekli.",
      },
      400,
    );
  }

  const lines = (csv || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const participants: { email: string; name: string }[] = [];
  const parseErrors: string[] = [];
  for (const line of lines) {
    const [rawEmail, rawName] = line.split(",");
    const email = normalizeEmail(rawEmail || "");
    if (!email || !email.includes("@")) {
      parseErrors.push(`Geçersiz satır atlandı: "${line}"`);
      continue;
    }
    participants.push({ email, name: rawName?.trim() || email });
  }

  if (participants.length === 0 && noEmailNames.length === 0) {
    return c.json(
      {
        ok: false,
        error: "En az bir katılımcı (mailli ya da e-postasız) gerekli.",
        parseErrors,
      },
      400,
    );
  }

  const eventInsert = await c.env.DB.prepare(
    `INSERT INTO events (title, project_name, event_date, event_time, status, custom_invite_message, custom_invite_closing) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      title,
      projectName,
      eventDate,
      eventTime,
      asDraft ? "draft" : "scheduled",
      customMessage,
      customClosing,
    )
    .run();
  const eventId = eventInsert.meta.last_row_id;

  const siteUrl = new URL(c.req.url).origin + "/";
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  // Mailli katılımcıları TEK bir toplu (batch) istekte ekliyoruz — her kişi için ayrı ayrı
  // sırayla beklemek yerine, çok kişilik listelerde belirgin şekilde daha hızlı çalışır.
  if (participants.length > 0) {
    const insertStatements = participants.flatMap((p) => [
      c.env.DB.prepare(
        `INSERT INTO event_participants (event_id, email, name) VALUES (?, ?, ?)`,
      ).bind(eventId, p.email, p.name),
      c.env.DB.prepare(
        `INSERT INTO allowed_donors (email, name, is_permanent) VALUES (?, ?, 0)
         ON CONFLICT(email) DO UPDATE SET name = excluded.name`,
      ).bind(p.email, p.name),
    ]);
    await c.env.DB.batch(insertStatements);
  }

  // E-postası olmayan katılımcılar için sihirli link (manuel erişim) oluşturuluyor.
  // Bunlara otomatik mail gitmez — admin linki manuel olarak paylaşır.
  const manualLinks: { name: string; link: string }[] = [];
  for (const name of noEmailNames) {
    const { syntheticEmail, link } = await createManualAccessForName(
      c.env.DB,
      siteUrl,
      name,
      Number(eventId),
    );
    await c.env.DB.prepare(
      `INSERT INTO event_participants (event_id, email, name, mail_sent) VALUES (?, ?, ?, 0)`,
    )
      .bind(eventId, syntheticEmail, name)
      .run();
    manualLinks.push({ name, link });
  }

  if (asDraft) {
    return c.json({
      ok: true,
      eventId,
      total: participants.length,
      sent: 0,
      failed: 0,
      errors,
      parseErrors,
      manualLinks,
    });
  }

  await ensureAndNotifyGroupAccess(c, {
    id: Number(eventId),
    title,
    project_name: projectName,
    event_date: eventDate,
    event_time: eventTime,
  });

  for (const p of participants) {
    try {
      const result = await sendEventInviteToParticipant(
        c,
        {
          id: Number(eventId),
          title,
          project_name: projectName,
          event_date: eventDate,
          event_time: eventTime,
          custom_invite_message: customMessage,
          custom_invite_closing: customClosing,
        },
        p,
        siteUrl,
      );
      if (result.ok) sent++;
      else {
        failed++;
        errors.push(`${p.email}: ${result.error}`);
      }
    } catch (err: any) {
      failed++;
      errors.push(`${p.email}: ${err?.message || "Bilinmeyen hata"}`);
    }
  }

  return c.json({
    ok: true,
    eventId,
    total: participants.length,
    sent,
    failed,
    errors,
    parseErrors,
    manualLinks,
  });
});

app.get("/api/admin/events", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, project_name, event_date, event_time, status, status_note, created_at FROM events ORDER BY created_at DESC",
  ).all();

  const events = [];
  for (const ev of results as any[]) {
    const stats = await c.env.DB.prepare(
      "SELECT COUNT(*) as total, SUM(mail_sent) as sent FROM event_participants WHERE event_id = ?",
    )
      .bind(ev.id)
      .first<{ total: number; sent: number }>();
    events.push({
      ...ev,
      totalParticipants: stats?.total || 0,
      sentCount: stats?.sent || 0,
    });
  }

  return c.json({ ok: true, events });
});

app.post("/api/admin/events/:id/status", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const eventId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const status: string | undefined = body?.status;
  const note: string | null = body?.note?.trim() || null;
  const notify: boolean = body?.notify !== false;

  if (
    !status ||
    !["draft", "scheduled", "postponed", "cancelled"].includes(status)
  ) {
    return c.json({ ok: false, error: "Geçersiz durum." }, 400);
  }

  const event = (await c.env.DB.prepare(
    "SELECT id, title, project_name, event_date, event_time, status AS previous_status, custom_invite_message, custom_invite_closing FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first()) as {
    id: number;
    title: string;
    project_name: string;
    event_date: string;
    event_time: string;
    previous_status: string;
    custom_invite_message: string | null;
    custom_invite_closing: string | null;
  } | null;

  if (!event) return c.json({ ok: false, error: "Etkinlik bulunamadı." }, 404);

  await c.env.DB.prepare(
    "UPDATE events SET status = ?, status_note = ? WHERE id = ?",
  )
    .bind(status, note, eventId)
    .run();

  let notified = 0;
  const notifyErrors: string[] = [];
  let sentType: "invite" | "notice" | "none" = "none";
  const wasDraft = event.previous_status === "draft";

  if (notify && wasDraft && status === "scheduled") {
    sentType = "invite";
    const siteUrl = new URL(c.req.url).origin + "/";

    await ensureAndNotifyGroupAccess(c, {
      id: event.id,
      title: event.title,
      project_name: event.project_name,
      event_date: event.event_date,
      event_time: event.event_time,
    });

    const { results: participants } = await c.env.DB.prepare(
      "SELECT email, name FROM event_participants WHERE event_id = ?",
    )
      .bind(eventId)
      .all();

    for (const p of participants as any[]) {
      const result = await sendEventInviteToParticipant(
        c,
        {
          id: event.id,
          title: event.title,
          project_name: event.project_name,
          event_date: event.event_date,
          event_time: event.event_time,
          custom_invite_message: event.custom_invite_message,
          custom_invite_closing: event.custom_invite_closing,
        },
        { email: p.email, name: p.name },
        siteUrl,
      );
      if (result.ok) notified++;
      else notifyErrors.push(`${p.email}: ${result.error}`);
    }
  } else if (notify && (status === "cancelled" || status === "postponed")) {
    sentType = "notice";
    const { results: participants } = await c.env.DB.prepare(
      "SELECT email, name FROM event_participants WHERE event_id = ?",
    )
      .bind(eventId)
      .all();

    for (const p of participants as any[]) {
      try {
        const html = buildEventStatusChangeHtml({
          name: p.name || p.email,
          title: event.title,
          projectName: event.project_name,
          status: status as "postponed" | "cancelled",
          note,
        });
        const subject =
          status === "cancelled"
            ? `${event.title} - Etkinlik İptal Edildi`
            : `${event.title} - Etkinlik Ertelendi`;
        await sendEmail(c.env, p.email, subject, html);
        notified++;
      } catch (err: any) {
        notifyErrors.push(`${p.email}: ${err?.message || "Bilinmeyen hata"}`);
      }
    }
  }

  return c.json({ ok: true, notified, notifyErrors, sentType });
});

app.post("/api/admin/events/:id/add-participant", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const eventId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const email = body?.email ? normalizeEmail(body.email) : null;
  const name: string = body?.name?.trim() || email || "";

  if (!email || !email.includes("@")) {
    return c.json({ ok: false, error: "Geçerli bir e-posta gerekli." }, 400);
  }

  const event = (await c.env.DB.prepare(
    "SELECT id, title, project_name, event_date, event_time, status, custom_invite_message, custom_invite_closing FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first()) as {
    id: number;
    title: string;
    project_name: string;
    event_date: string;
    event_time: string;
    status: string;
    custom_invite_message: string | null;
    custom_invite_closing: string | null;
  } | null;

  if (!event) return c.json({ ok: false, error: "Etkinlik bulunamadı." }, 404);

  await c.env.DB.prepare(
    `INSERT INTO event_participants (event_id, email, name) VALUES (?, ?, ?)`,
  )
    .bind(eventId, email, name)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO allowed_donors (email, name, is_permanent) VALUES (?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name`,
  )
    .bind(email, name)
    .run();

  if (event.status === "draft") {
    return c.json({ ok: true, draftAdded: true });
  }

  const siteUrl = new URL(c.req.url).origin + "/";
  const result = await sendEventInviteToParticipant(
    c,
    event,
    { email, name },
    siteUrl,
  );

  if (!result.ok) {
    return c.json(
      {
        ok: false,
        error: "Katılımcı eklendi ama mail gönderilemedi: " + result.error,
      },
      500,
    );
  }
  return c.json({ ok: true });
});

app.get("/api/admin/events/:id/participants", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const eventId = c.req.param("id");
  const { results } = await c.env.DB.prepare(
    "SELECT email, name FROM event_participants WHERE event_id = ? ORDER BY email",
  )
    .bind(eventId)
    .all();
  return c.json({ ok: true, participants: results });
});

// Bir katılımcıyı SADECE bu etkinliğin listesinden çıkartır (genel bağışçı listesine dokunmaz)
app.post("/api/admin/events/:id/participants/remove", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const eventId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const email = body?.email ? normalizeEmail(body.email) : null;
  if (!email) return c.json({ ok: false, error: "E-posta gerekli." }, 400);

  await c.env.DB.prepare(
    "DELETE FROM event_participants WHERE event_id = ? AND email = ?",
  )
    .bind(eventId, email)
    .run();

  return c.json({ ok: true });
});

app.post("/api/admin/events/:id/thank-you", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const eventId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const message: string | undefined = body?.message?.trim();
  const videoUrl: string | null = body?.videoUrl?.trim() || null;
  const recipientsCsv: string | undefined = body?.recipientsCsv;

  if (!message)
    return c.json({ ok: false, error: "Mesaj metni gerekli." }, 400);

  const event = (await c.env.DB.prepare(
    "SELECT id, title, project_name, event_date, event_time FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first()) as {
    id: number;
    title: string;
    project_name: string;
    event_date: string;
    event_time: string;
  } | null;

  if (!event) return c.json({ ok: false, error: "Etkinlik bulunamadı." }, 404);

  let recipients: { email: string; name: string }[] = [];
  if (recipientsCsv && recipientsCsv.trim()) {
    const lines = recipientsCsv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const line of lines) {
      const [rawEmail, rawName] = line.split(",");
      const email = normalizeEmail(rawEmail || "");
      if (email && email.includes("@")) {
        recipients.push({ email, name: rawName?.trim() || email });
      }
    }
  } else {
    const { results } = await c.env.DB.prepare(
      "SELECT email, name FROM event_participants WHERE event_id = ?",
    )
      .bind(eventId)
      .all();
    recipients = results as any[];
  }

  if (recipients.length === 0) {
    return c.json(
      { ok: false, error: "Gönderilecek geçerli bir alıcı bulunamadı." },
      400,
    );
  }

  let sent = 0;
  const errors: string[] = [];

  for (const p of recipients) {
    try {
      const html = buildThankYouHtml({
        name: p.name || p.email,
        title: event.title,
        message,
        videoUrl,
      });
      await sendEmail(c.env, p.email, `${event.title} - Teşekkür Ederiz`, html);
      sent++;
    } catch (err: any) {
      errors.push(`${p.email}: ${err?.message || "Bilinmeyen hata"}`);
    }
  }

  return c.json({ ok: true, sent, total: recipients.length, errors });
});

// ---------- Admin: moderatör şifresi ----------

app.post("/api/admin/set-moderator-password", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const body = await c.req.json().catch(() => null);
  const password: string | undefined = body?.password;
  if (!password || password.length < 6) {
    return c.json({ ok: false, error: "Şifre en az 6 karakter olmalı." }, 400);
  }
  const hash = await sha256Hex(password);
  await c.env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('moderator_password_hash', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(hash)
    .run();
  return c.json({ ok: true });
});

app.get("/api/admin/moderator-status", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const row = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'moderator_password_hash'",
  ).first();
  return c.json({ ok: true, hasPassword: !!row });
});

// ---------- Grup bildirim e-postası (etkinlik grup giriş kodlarının gönderileceği adres) ----------

app.get("/api/admin/settings/group-email", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const row = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'group_notification_email'",
  ).first<{ value: string }>();
  return c.json({ ok: true, email: row?.value || "" });
});

app.post("/api/admin/settings/group-email", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const body = await c.req.json().catch(() => null);
  const email: string = body?.email?.trim() || "";

  await c.env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('group_notification_email', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(email)
    .run();

  return c.json({ ok: true });
});

// Bir etkinliğin grup giriş kodunu döndürür (admin panelde göstermek için)
app.get("/api/admin/events/:id/group-access", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);
  const eventId = c.req.param("id");
  const row = (await c.env.DB.prepare(
    "SELECT username, code FROM event_group_access WHERE event_id = ?",
  )
    .bind(eventId)
    .first()) as { username: string; code: string } | null;
  return c.json({ ok: true, access: row || null });
});

// ---------- Detaylı Rapor ----------

app.get("/api/admin/report", async (c) => {
  if (!checkAdminAuth(c)) return c.json({ ok: false, error: "Yetkisiz." }, 401);

  const { results: eventRows } = await c.env.DB.prepare(
    "SELECT id, title, project_name, event_date, event_time, status, status_note, created_at FROM events ORDER BY created_at DESC",
  ).all();

  const events = [];
  for (const ev of eventRows as any[]) {
    const { results: participants } = await c.env.DB.prepare(
      "SELECT email, name, mail_sent, mail_error, sent_at FROM event_participants WHERE event_id = ? ORDER BY email",
    )
      .bind(ev.id)
      .all();

    // Bu etkinlikte kim ne kadar süre yayında kaldı (aynı kişi birden fazla
    // sekme/cihazdan bağlandıysa toplanır; hâlâ açık olan bağlantılar için
    // "şu ana kadar" hesaplanır).
    const { results: watchRows } = await c.env.DB.prepare(
      `SELECT email,
              SUM(COALESCE(disconnected_at, CAST(strftime('%s','now') AS INTEGER)) - connected_at) AS totalSeconds
       FROM watch_sessions WHERE event_id = ? GROUP BY email`,
    )
      .bind(ev.id)
      .all();
    const watchByEmail = new Map<string, number>();
    for (const w of watchRows as any[]) {
      watchByEmail.set(w.email, w.totalSeconds || 0);
    }

    const participantsWithWatch = (participants as any[]).map((p) => ({
      ...p,
      watchSeconds: watchByEmail.get(p.email) ?? 0,
    }));

    events.push({ ...ev, participants: participantsWithWatch });
  }

  let recordings: any[] = [];
  let recordingsError: string | null = null;

  if (c.env.CF_ACCOUNT_ID && c.env.CF_STREAM_API_TOKEN) {
    try {
      const listRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/stream/live_inputs/${c.env.STREAM_LIVE_INPUT_UID}/videos`,
        { headers: { Authorization: `Bearer ${c.env.CF_STREAM_API_TOKEN}` } },
      );
      const listData: any = await listRes.json();

      if (listRes.ok && listData.result) {
        for (const video of listData.result) {
          let downloadUrl: string | null = null;
          let downloadStatus = "unknown";
          try {
            const dlRes = await fetch(
              `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/stream/${video.uid}/downloads`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${c.env.CF_STREAM_API_TOKEN}`,
                },
              },
            );
            const dlData: any = await dlRes.json();
            if (dlRes.ok && dlData.result?.default) {
              downloadUrl = dlData.result.default.url;
              downloadStatus = dlData.result.default.status;
            }
          } catch {
            // yoksay
          }
          recordings.push({
            uid: video.uid,
            created: video.created,
            duration: video.duration,
            thumbnail: video.thumbnail,
            downloadUrl,
            downloadStatus,
          });
        }
      } else {
        recordingsError =
          listData?.errors?.[0]?.message || "Kayıtlar alınamadı.";
      }
    } catch (err: any) {
      recordingsError = err?.message || "Cloudflare Stream'e bağlanılamadı.";
    }
  } else {
    recordingsError = "CF_ACCOUNT_ID / CF_STREAM_API_TOKEN ayarlanmamış.";
  }

  const { results: feedbackRows } = await c.env.DB.prepare(
    "SELECT email, rating, system_feedback, personal_feedback, created_at FROM feedback ORDER BY created_at DESC",
  ).all();
  const ratedRows = (feedbackRows as any[]).filter((f) => f.rating !== null);
  const avgRating =
    ratedRows.length > 0
      ? ratedRows.reduce((sum, f) => sum + f.rating, 0) / ratedRows.length
      : null;

  return c.json({
    ok: true,
    events,
    recordings,
    recordingsError,
    feedback: {
      entries: feedbackRows,
      averageRating: avgRating,
      count: feedbackRows.length,
    },
  });
});

// ---------- Statik dosyalar (Workers Assets) ----------

app.get("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
