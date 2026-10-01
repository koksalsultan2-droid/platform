import { DurableObject } from "cloudflare:workers";

interface RoomEnv {
  DB: D1Database;
}

// Bir bağışçının mikrofon/kamera isteğinin durumu
type RequestType = "mic" | "camera";

interface PendingRequest {
  email: string;
  name: string;
  type: RequestType;
  requestedAt: number;
}

interface ActiveParticipant {
  email: string;
  name: string;
  type: RequestType;
  sessionId: string;
  trackName: string;
  approvedAt: number;
}

interface Viewer {
  email: string;
  name: string;
}

interface ChatMessage {
  id: string;
  email: string;
  name: string;
  text: string;
  ts: number;
}

interface RoomState {
  pending: PendingRequest[];
  active: ActiveParticipant[];
  chat: ChatMessage[];
}

type ClientRole = "viewer" | "moderator";

interface ConnMeta {
  role: ClientRole;
  email?: string; // sadece viewer için
  name?: string; // sadece viewer için
  eventId?: number | null; // sadece viewer için — izleme süresi hangi etkinliğe yazılsın
  watchSessionId?: number; // sadece viewer için — watch_sessions tablosundaki satır id'si
}

// ---------- Sohbette küfür/argo filtresi ----------
// Moderatör bir mesajı sildiğinde bile o mesaj silinene kadar herkese görünüyordu.
// Bunun yerine, aşağıdaki listeyle eşleşen mesajlar HİÇ yayınlanmadan (diğer
// izleyicilere ve moderatöre görünmeden) engellenir; sadece gönderen kişiye
// özel bir uyarı gider.
const BANNED_WORDS = [
  "amk",
  "amq",
  "aq",
  "orospu",
  "orospu cocugu",
  "piç",
  "pic",
  "yarrak",
  "yarak",
  "sik",
  "siktir",
  "got",
  "göt",
  "ibne",
  "gavat",
  "kahpe",
  "puşt",
  "pust",
  "salak",
  "aptal",
  "gerizekalı",
  "gerizekali",
  "mal herif",
  "dalyarak",
  "yavşak",
  "yavsak",
  "şerefsiz",
  "serefsiz",
  "haysiyetsiz",
  "fuck",
  "shit",
  "bitch",
  "asshole",
];

// Mesajı sadeleştirir: küçük harfe çevirir, Türkçe karakterleri sadeleştirir,
// yaygın "leetspeak" (4->a, 3->e, 1->i, 0->o gibi) değişimlerini geri çevirir ve
// harf olmayan karakterleri (boşluk, nokta, yıldız vb. ile araya kelime bölme
// girişimlerini) atar — böylece "a.m.k" veya "a4q" gibi basit atlatmalar da yakalanır.
function normalizeForFilter(text: string): string {
  return text
    .toLocaleLowerCase("tr-TR")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ş/g, "s")
    .replace(/ü/g, "u")
    .replace(/4/g, "a")
    .replace(/3/g, "e")
    .replace(/1/g, "i")
    .replace(/0/g, "o")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/[^a-z]/g, "");
}

function containsProfanity(text: string): boolean {
  const normalized = normalizeForFilter(text);
  if (!normalized) return false;
  return BANNED_WORDS.some((word) =>
    normalized.includes(normalizeForFilter(word)),
  );
}

// Sohbet mesajları gönderildikten 3 saat sonra otomatik olarak silinir —
// canlı yayın kaydı değil, sadece o anki canlı deneyimin bir parçası olduğu için
// kalıcı olarak saklanmasına gerek yok.
const CHAT_MESSAGE_TTL_MS = 3 * 60 * 60 * 1000; // 3 saat

// NOT: Durable Object'ler zaman zaman "hazırda beklemeye" (hibernation) alınır ve
// JS instance'ı yok edilip yeniden oluşturulabilir. Bu yüzden bağlantı bilgilerini
// (kim moderatör, kim hangi bağışçı) normal bir Map'te bellekte TUTAMAYIZ — hibernation
// sonrası kaybolur. Bunun yerine her WebSocket'in üzerine serializeAttachment ile
// bilgiyi "yapıştırıyoruz", bu veri hibernation'dan etkilenmiyor. Aktif bağlantıları
// listelemek için de this.ctx.getWebSockets() kullanıyoruz (kendi Map'imiz yerine).
// "Şu an bağlı izleyiciler" listesi de kalıcı depolamada TUTULMUYOR — her an
// gerçek WebSocket bağlantılarından canlı olarak hesaplanıyor, böylece her zaman doğru.

export class ModeratorRoom extends DurableObject<RoomEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) {
      const role = (url.searchParams.get("role") || "viewer") as ClientRole;
      const email = url.searchParams.get("email") || undefined;
      const name = url.searchParams.get("name") || email;
      const eventIdParam = url.searchParams.get("eventId");
      const eventId =
        eventIdParam !== null && eventIdParam !== ""
          ? Number(eventIdParam)
          : null;

      // İzleyici bağlandığı anda "izleme süresi" ölçümünü başlat: watch_sessions
      // tablosuna bir satır ekle, kapanınca (webSocketClose) aynı satır güncellenir.
      let watchSessionId: number | undefined;
      if (role === "viewer" && email) {
        try {
          const inserted = await this.env.DB.prepare(
            `INSERT INTO watch_sessions (email, name, event_id, connected_at) VALUES (?, ?, ?, ?)`,
          )
            .bind(email, name || email, eventId, (Date.now() / 1000) | 0)
            .run();
          watchSessionId = inserted.meta?.last_row_id as number | undefined;
        } catch {
          // D1 erişimi başarısız olsa bile bağlantı kurulmaya devam etsin, kritik değil
        }
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);

      // Bağlantı bilgisini kalıcı şekilde WebSocket'e yapıştır (hibernation-safe)
      server.serializeAttachment({
        role,
        email,
        name,
        eventId,
        watchSessionId,
      } satisfies ConnMeta);

      // Yeni bağlanan istemciye mevcut durumu gönder
      await this.broadcastState();

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    const meta = ws.deserializeAttachment() as ConnMeta | null;
    if (!meta) return;

    if (msg.type === "request" && meta.role === "viewer") {
      const reqType: RequestType = msg.reqType === "camera" ? "camera" : "mic";
      const state = await this.getState();

      const alreadyPending = state.pending.some(
        (p) => p.email === meta.email && p.type === reqType,
      );
      const alreadyActive = state.active.some(
        (a) => a.email === meta.email && a.type === reqType,
      );
      if (!alreadyPending && !alreadyActive && meta.email) {
        state.pending.push({
          email: meta.email,
          name: msg.name || meta.email,
          type: reqType,
          requestedAt: Date.now(),
        });
        await this.setState(state);
        await this.broadcastState();
      }
      return;
    }

    if (msg.type === "cancel-request" && meta.role === "viewer") {
      const state = await this.getState();
      state.pending = state.pending.filter(
        (p) => !(p.email === meta.email && p.type === msg.reqType),
      );
      await this.setState(state);
      await this.broadcastState();
      return;
    }

    if (msg.type === "approve" && meta.role === "moderator") {
      const state = await this.getState();
      const idx = state.pending.findIndex(
        (p) => p.email === msg.email && p.type === msg.reqType,
      );
      if (idx !== -1) {
        const req = state.pending[idx];
        state.pending.splice(idx, 1);
        await this.setState(state);
        await this.broadcastState();
        this.sendToViewer(req.email, { type: "approved", reqType: req.type });
      }
      return;
    }

    if (msg.type === "deny" && meta.role === "moderator") {
      const state = await this.getState();
      state.pending = state.pending.filter(
        (p) => !(p.email === msg.email && p.type === msg.reqType),
      );
      await this.setState(state);
      await this.broadcastState();
      this.sendToViewer(msg.email, { type: "denied", reqType: msg.reqType });
      return;
    }

    if (msg.type === "revoke" && meta.role === "moderator") {
      const state = await this.getState();
      state.active = state.active.filter(
        (a) => !(a.email === msg.email && a.type === msg.reqType),
      );
      await this.setState(state);
      await this.broadcastState();
      this.sendToViewer(msg.email, { type: "revoked", reqType: msg.reqType });
      return;
    }

    if (msg.type === "track-ready" && meta.role === "viewer") {
      const state = await this.getState();
      const already = state.active.some(
        (a) => a.email === meta.email && a.type === msg.reqType,
      );
      if (!already && meta.email) {
        state.active.push({
          email: meta.email,
          name: msg.name || meta.email,
          type: msg.reqType,
          sessionId: msg.sessionId,
          trackName: msg.trackName,
          approvedAt: Date.now(),
        });
        await this.setState(state);
        await this.broadcastState();
      }
      return;
    }

    if (msg.type === "stop" && meta.role === "viewer") {
      const state = await this.getState();
      state.active = state.active.filter(
        (a) => !(a.email === meta.email && a.type === msg.reqType),
      );
      await this.setState(state);
      await this.broadcastState();
      return;
    }

    if (msg.type === "chat-send" && meta.role === "viewer") {
      const text =
        typeof msg.text === "string" ? msg.text.trim().slice(0, 500) : "";
      if (!text || !meta.email) return;

      if (containsProfanity(text)) {
        // Mesaj hiçbir zaman diğer izleyicilere veya moderatöre gitmez —
        // sadece gönderen kişiye özel bir uyarı gönderilir.
        try {
          ws.send(
            JSON.stringify({
              type: "chat-blocked",
              reason:
                "Mesajınız uygunsuz içerik barındırdığı için gönderilemedi.",
            }),
          );
        } catch {
          // yoksay
        }
        return;
      }

      const state = await this.getState();
      state.chat.push({
        id: crypto.randomUUID(),
        email: meta.email,
        name: meta.name || meta.email,
        text,
        ts: Date.now(),
      });
      // 3 saatten eski mesajları temizle + bellek/depolamayı şişirmemek için son 200 mesajı tut
      state.chat = pruneOldChatMessages(state.chat).slice(-200);
      await this.setState(state);
      await this.broadcastState();
      return;
    }

    if (msg.type === "chat-remove" && meta.role === "moderator") {
      const state = await this.getState();
      state.chat = state.chat.filter((m) => m.id !== msg.id);
      await this.setState(state);
      await this.broadcastState();
      return;
    }

    if (msg.type === "kick" && meta.role === "moderator") {
      const targetEmail = typeof msg.email === "string" ? msg.email : null;
      if (!targetEmail) return;

      // O kişinin tüm bağlı sekmelerini/cihazlarını zorla kapat (özel bir close kodu ile,
      // istemci taraf bunu "moderatör tarafından atıldın" olarak yorumluyor)
      for (const ws2 of this.ctx.getWebSockets()) {
        const m2 = ws2.deserializeAttachment() as ConnMeta | null;
        if (m2?.role === "viewer" && m2.email === targetEmail) {
          try {
            ws2.close(4001, "Kicked by moderator");
          } catch {
            // yoksay
          }
        }
      }

      // Bekleyen/aktif kayıtlarından da temizle
      const state = await this.getState();
      const changed =
        state.pending.some((p) => p.email === targetEmail) ||
        state.active.some((a) => a.email === targetEmail);
      if (changed) {
        state.pending = state.pending.filter((p) => p.email !== targetEmail);
        state.active = state.active.filter((a) => a.email !== targetEmail);
        await this.setState(state);
      }

      // Oturumunu da geçersiz kıl — sayfayı yenileyip tekrar girmeye çalışsa bile
      // yeniden kimlik doğrulaması (OTP / kullanıcı adı+kod) yapması gerekiyor
      try {
        await this.env.DB.prepare("DELETE FROM sessions WHERE email = ?")
          .bind(targetEmail)
          .run();
      } catch {
        // D1 erişimi başarısız olsa bile bağlantıyı kapatmış olduk, kritik değil
      }

      await this.broadcastState();
      return;
    }
  }

  async webSocketClose(ws: WebSocket) {
    const meta = ws.deserializeAttachment() as ConnMeta | null;
    if (meta?.role === "viewer" && meta.email) {
      const state = await this.getState();
      const changed =
        state.pending.some((p) => p.email === meta.email) ||
        state.active.some((a) => a.email === meta.email);
      if (changed) {
        state.pending = state.pending.filter((p) => p.email !== meta.email);
        state.active = state.active.filter((a) => a.email !== meta.email);
        await this.setState(state);
      }

      // İzleme süresi ölçümünü kapat
      if (meta.watchSessionId) {
        try {
          await this.env.DB.prepare(
            "UPDATE watch_sessions SET disconnected_at = ? WHERE id = ?",
          )
            .bind((Date.now() / 1000) | 0, meta.watchSessionId)
            .run();
        } catch {
          // kritik değil, yoksay
        }
      }
    }
    // Bağlantı koptuğunda "kim izliyor" listesi de değişmiş olur, her durumda yayınla
    await this.broadcastState();
  }

  // Şu an bağlı olan tüm izleyicileri (mikrofon/kamera açık olsun olmasın) hesaplar
  private getConnectedViewers(): Viewer[] {
    const seen = new Map<string, Viewer>();
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as ConnMeta | null;
      if (meta?.role === "viewer" && meta.email) {
        seen.set(meta.email, {
          email: meta.email,
          name: meta.name || meta.email,
        });
      }
    }
    return [...seen.values()];
  }

  private async broadcastState() {
    const state = await this.getState();
    const viewers = this.getConnectedViewers();
    const data = JSON.stringify({
      type: "state",
      state: { ...state, viewers },
    });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // bağlantı kopmuş olabilir, yoksay
      }
    }
  }

  private sendToViewer(email: string, payload: any) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as ConnMeta | null;
      if (meta?.role === "viewer" && meta.email === email) {
        try {
          ws.send(data);
        } catch {
          // yoksay
        }
      }
    }
  }

  private async getState(): Promise<RoomState> {
    const stored = await this.ctx.storage.get<RoomState>("state");
    if (!stored) return { pending: [], active: [], chat: [] };
    if (!stored.chat) stored.chat = []; // eski kayıtlarda chat alanı olmayabilir
    stored.chat = pruneOldChatMessages(stored.chat);
    return stored;
  }

  private async setState(state: RoomState) {
    await this.ctx.storage.put("state", state);
  }
}

// 3 saatten eski sohbet mesajlarını eler
function pruneOldChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const cutoff = Date.now() - CHAT_MESSAGE_TTL_MS;
  return messages.filter((m) => m.ts >= cutoff);
}
