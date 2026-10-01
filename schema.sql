-- Admin panelinden yüklenen, siteye giriş yapmaya yetkili bağışçılar.
-- is_permanent=1: "Süresiz Bağışçı Girişi" sekmesinden eklenmiş, erişimi hiç kapanmaz.
-- is_permanent=0: sadece bir etkinliğe davet edilmiş, o etkinliğin penceresi (etkinlik
-- tarihinden 2 gün sonrasına kadar) kapanınca ve başka aktif/süresiz bağı yoksa OTP
-- girişi de otomatik kapanır.
CREATE TABLE IF NOT EXISTS allowed_donors (
  email TEXT PRIMARY KEY,
  name TEXT,
  is_permanent INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- OTP (tek kullanımlık giriş kodu) kayıtları
CREATE TABLE IF NOT EXISTS otp_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Aktif oturumlar (session cookie'sinin hash'i)
-- event_id: bu oturum hangi etkinliğin linki/kodu ile açıldıysa o etkinliğin id'si
-- (süresiz/genel giriş ise NULL) — izleme süresi raporunda hangi etkinliğe
-- yazılacağını belirlemek için kullanılır.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  event_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

-- KVKK onay kayıtları (giriş sırasında checkbox işaretlendiğinde loglanır)
CREATE TABLE IF NOT EXISTS kvkk_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  accepted_at INTEGER NOT NULL
);

-- Genel ayarlar (moderatör şifresi hash'i vb. anahtar-değer deposu)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Admin panelinden planlanan etkinlikler (açılış programları vb.)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  project_name TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- 'draft' | 'scheduled' | 'postponed' | 'cancelled'
  status_note TEXT,
  custom_invite_message TEXT, -- admin tarafından düzenlenmiş davet metni (boşsa standart metin kullanılır)
  custom_invite_closing TEXT, -- admin tarafından düzenlenmiş kapanış metni (boşsa standart metin kullanılır)
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Bir etkinliğe davet edilen katılımcılar ve mail gönderim durumu
-- magic_token: mail'e gömülen kişisel giriş linkinin gizli kodu
-- bound_device_id: link ilk kullanıldığı cihaza kilitlenince doldurulur
CREATE TABLE IF NOT EXISTS event_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  mail_sent INTEGER NOT NULL DEFAULT 0,
  mail_error TEXT,
  sent_at INTEGER,
  magic_token TEXT,
  bound_device_id TEXT,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE INDEX IF NOT EXISTS idx_event_participants_event ON event_participants(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_participants_magic_token ON event_participants(magic_token) WHERE magic_token IS NOT NULL;

-- E-postası olmayan bağışçılar için: admin panelinden oluşturulan sihirli link ile giriş.
-- "code" artık uzun/rastgele bir gizli token tutuyor (linkin içine gömülür, yazılmaz).
-- "bound_device_id" ilk başarılı girişte doldurulur, o andan sonra link SADECE o cihazda çalışır.
-- E-postası olmayan bağışçılar için: admin panelinden oluşturulan sihirli link ile giriş.
-- "code" artık uzun/rastgele bir gizli token tutuyor (linkin içine gömülür, yazılmaz).
-- "bound_device_id" ilk başarılı girişte doldurulur, o andan sonra link SADECE o cihazda çalışır.
-- "event_id" NULL ise SÜRESİZ erişim (standalone kart); dolu ise o etkinliğe özel, süreli erişim
-- (Etkinlik Planlama'daki "E-postası yok" seçeneğinden oluşturulur, aynı e.html mantığıyla süreli).
CREATE TABLE IF NOT EXISTS manual_access (
  username TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  synthetic_email TEXT NOT NULL UNIQUE,
  bound_device_id TEXT,
  event_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Etkinlik bazlı GRUP giriş kodu: aynı kullanıcı adı+kod, farklı kişilerce kullanılabilir
-- (her biri girişte kendi adını yazar). Portföy yöneticilerinin, başka portföydeki
-- bağışçıları da davet edebilmesi için tasarlandı.
CREATE TABLE IF NOT EXISTS event_group_access (
  event_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

-- Bir bağışçının canlı yayında ne kadar süre kaldığını ölçmek için: moderatör odasına
-- WebSocket bağlantısı her açıldığında bir satır eklenir (connected_at), bağlantı
-- kapandığında aynı satır disconnected_at ile güncellenir. Aynı kişi birden fazla
-- sekme/cihazdan bağlanırsa birden fazla satır oluşur — rapor ekranında toplanır.
CREATE TABLE IF NOT EXISTS watch_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT,
  event_id INTEGER,
  connected_at INTEGER NOT NULL,
  disconnected_at INTEGER
);

-- Bağışçının yayın sonrası çıkışta doldurduğu memnuniyet anketi
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  rating INTEGER,
  system_feedback TEXT,
  personal_feedback TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

