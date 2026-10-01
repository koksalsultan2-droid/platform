# Bağışçı Canlı Yayın Sitesi — Kurulum

Bu proje **Cloudflare Workers + D1** üzerinde çalışır. E-posta OTP ile giriş yapan
bağışçılar, admin panelinden yüklediğin liste doğrultusunda canlı yayını izleyebilir.

## 1) Gereksinimler
- Node.js kurulu bir bilgisayar
- Cloudflare hesabı (zaten var)
- [Resend](https://resend.com) hesabı — ücretsiz tier'ı var, e-posta göndermek için kullanıyoruz.
  Kayıt olduktan sonra bir **domain doğrulaması** yapman lazım (kendi domainin), yoksa e-postalar
  "resend.dev" test adresinden gider ve spam'e düşme ihtimali yüksek olur.

## 2) Kurulum adımları

```bash
cd donor-stream
npm install
npx wrangler login          # Cloudflare hesabınla giriş yap

# D1 veritabanını oluştur
npx wrangler d1 create donor-stream-db
# Çıktıda gelen "database_id" değerini wrangler.toml içine yapıştır

# Tabloları oluştur (yerel test için)
npm run db:init
# Gerçek (canlı) veritabanı için
npm run db:init:remote
```

## 3) Gizli değerleri (secrets) ekle

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET       # rastgele uzun bir metin, örn: openssl rand -hex 32
npx wrangler secret put STREAM_CUSTOMER_CODE  # Cloudflare Stream panelindeki "Customer subdomain" (customer-frv4jvoi0mir... kısmı, .cloudflarestream.com hariç)
npx wrangler secret put STREAM_LIVE_INPUT_UID # Live Input'un UID'si (Live Input details altında)
```

`src/index.ts` içindeki `sendOtpEmail` fonksiyonunda `from:` alanını
kendi doğrulanmış domain adresinle değiştirmeyi unutma:
```
from: "Bağış Yayını <giris@SENIN-DOMAININ.com>",
```

## 4) Test et ve yayınla

```bash
npm run dev        # yerelde test (localhost:8787)
npm run deploy      # canlıya al
```

Deploy sonrası Cloudflare sana bir `*.workers.dev` adresi verecek — bunu kendi
domainine bağlamak istersen Cloudflare Dashboard > Workers & Pages > Custom Domains
kısmından ekleyebilirsin.

## 5) Admin panelini kullanma

`https://SENIN-SITEN/admin.html` adresine git, `wrangler secret put ADMIN_PASSWORD`
ile belirlediğin şifreyi gir. Textarea'ya şu formatta bağışçı listesi yapıştır:

```
ahmet@ornek.com,Ahmet Yılmaz
zeynep@ornek.com,Zeynep Kaya
mehmet@ornek.com
```

"Yükle / Güncelle" butonuna basınca liste D1'e kaydedilir. Aynı e-posta tekrar
yüklenirse ismi günceller, kaydı çoğaltmaz.

## 6) YENİ — Moderatör / Mikrofon-Kamera Özelliği

Bu özellik, bağışçıların mikrofon/kamera açma isteği göndermesini, bir moderatörün
bunu onaylamasını ve onaylanan kişinin sesinin/görüntüsünün tüm izleyicilere
canlı olarak gösterilmesini sağlar. **Larix ile yaptığın ana yayını hiç etkilemez**,
tamamen web sitesi üzerinde ayrı bir katman olarak çalışır.

### 6.1) Cloudflare Realtime (Calls) uygulaması oluştur

1. dash.cloudflare.com → sol menüden **Realtime** (veya "Calls") bölümüne git.
2. **"Create Application"** ile yeni bir uygulama oluştur, ismini `donor-stream` gibi verebilirsin.
3. Oluşunca sana bir **Application ID** ve bir **App Secret / Token** verilecek. İkisini de not al.

### 6.2) Yeni gizli değerleri ekle

```bash
npx wrangler secret put CF_REALTIME_APP_ID
npx wrangler secret put CF_REALTIME_APP_TOKEN
```

### 6.3) Veritabanını güncelle (yeni tablolar için)

```bash
npm run db:init:remote
```

Bu komut `schema.sql`'i tekrar çalıştırır — `CREATE TABLE IF NOT EXISTS` kullandığımız
için mevcut verilerine (bağışçı listesi vb.) hiç dokunmaz, sadece eksik yeni
tabloları (`settings`) ekler.

### 6.4) Yeniden deploy et

```bash
npm run deploy
```

Bu, yeni Durable Object'i (`ModeratorRoom`) de Cloudflare'e kaydedecek.

### 6.5) Moderatör şifresini belirle

`/admin.html` sayfana git, en alttaki **"Moderatör Şifresi"** kartından bir şifre belirle.
Bu şifreyi moderatörlük yapacak kişiye ilet.

### 6.6) Moderatör paneli

Moderatör, `https://SENIN-SITEN/moderator.html` adresinden bu şifreyle giriş yapıp
gelen istekleri onaylayıp reddedebilir, aktif yayındaki kişileri istediği an kapatabilir.

### ÖNEMLİ NOTLAR

- Bu özellik **gerçek zamanlı WebRTC** teknolojisi kullanıyor, tarayıcı uyumluluğu
  ve ağ koşullarına göre bazı durumlarda ince ayar/hata ayıklama gerekebilir —
  özellikle ilk testlerde bir sorunla karşılaşırsan, tarayıcı konsolundaki (F12)
  hata mesajını paylaşırsan birlikte çözebiliriz.
- Kullanım ücreti: Cloudflare Realtime, sabit aylık ücret değil, **kullanım
  başına** (~$0.05/GB) faturalandırılıyor. Küçük ölçekli kullanımda ayda birkaç
  dolar civarında kalması beklenir.
- Durable Objects, Cloudflare'in **ücretsiz Workers planında** da çalışıyor,
  bu özellik için Workers Paid'e geçmen gerekmiyor.

## ÖNEMLİ — Güvenlik notu

Bu sistem, **sayfa erişimini** OTP ile koruyor. Ancak Cloudflare Stream'in
`iframe` embed linki varsayılan olarak herkese açıktır — yani birisi bu linki
(iframe src URL'sini) tarayıcı geliştirici araçlarından görüp doğrudan paylaşırsa,
OTP'siz de izleyebilir.

Gerçek/hassas bir bağış etkinliği için bunu tamamen kapatmak istersen, Cloudflare
Stream'de **"Require signed URLs"** özelliğini live input üzerinde açman ve
Worker'da her izleyici için kısa ömürlü imzalı bir oynatma token'ı üretmen gerekir.
Bu ekstra bir adım — istersen bir sonraki aşamada bunu da ekleyelim.
