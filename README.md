# Ünal Sigorta Teklif Ajanı v1.1

Easypanel üzerinde çalışan, yetkili sigorta portallarındaki trafik tekliflerini kalıcı bir kuyrukta toplayan çevrimiçi sorgu altyapısıdır. Formun gönderilmesi başarı sayılmaz; yalnızca şirket ve fiyat verisi okunabilen sonuçlar teklif listesine girer.

## Canlı entegrasyon durumu

- Sigorta Lion, Bi Tıkla Sigorta ve SigortaBaz için iki aşamalı İhsan adaptörü bulunur.
- İlk formdan sonra açılan araç cinsi, model yılı, marka/tip, şasi ve motor alanları ikinci aşamada doldurulur.
- Cloudflare/CAPTCHA, eksik veri, alan eşleme hatası ve zaman aşımı birbirinden ayrı durumlar olarak gösterilir.
- Diğer portallar özel adaptörleri tamamlanana kadar varsayılan olarak kapalıdır. Arayüzde listelenmeleri canlı çalıştıkları anlamına gelmez.
- Sunucu açılışında ilk üç portal üzerinde kişisel veri göndermeyen form teşhisi çalışır. Son durum `/health` içindeki `portalProbes` alanında görülür.

## Mimari

- Kalıcı JSON iş deposu ve sunucu yeniden başlatma kurtarması
- İş kuyruğu ve portal başına sınırlı eşzamanlılık
- Portal başına ayrı, kalıcı Playwright oturumu
- Adaptör katmanı (`generic`, `ihsan`, `ihsan-frame`)
- SMS kodu bekleme/gönderme akışı; CAPTCHA atlama yok
- Retry, timeout, giriş gerekli, hız sınırı ve eşleme gerekli durumları
- Sonuç tekilleştirme ve şirket bazında en iyi fiyat özeti
- API v1, geriye uyumlu `/api/*` yolları ve SSE canlı olay akışı
- 30 günlük varsayılan iş saklama ve 0600 dosya izinleri

## Easypanel ayarları

- Kaynak: Bu GitHub deposu, `main` dalı
- Build: Dockerfile
- Uygulama portu: `4318`
- Kalıcı volume: `/app/data`
- Health check: `/health`

Ortam değişkenleri:

```env
PANEL_USER=unal
PANEL_PASSWORD=guclu-ve-benzersiz-bir-sifre
DEFAULT_PHONE=05XXXXXXXXX
MAX_CONCURRENCY=3
MAX_ACTIVE_JOBS=1
HEADLESS=true
NAVIGATION_TIMEOUT_MS=45000
RESULT_TIMEOUT_MS=120000
OTP_TIMEOUT_MS=300000
PORTAL_RETRY_COUNT=1
JOB_RETENTION_DAYS=30
ALLOWED_ORIGINS=
```

`PANEL_PASSWORD` yalnızca Easypanel içindeki Environment alanına yazılmalı; GitHub'a kaydedilmemelidir.

## API

- `GET /health` — servis, tarayıcı ve kuyruk sağlığı
- `GET /api/v1/portals` — portal ve entegrasyon durumları
- `PATCH /api/v1/portals/:id` — portalı aç/kapat
- `POST /api/v1/jobs` — sorgu oluştur
- `GET /api/v1/jobs/:id` — sorgu, portal durumları ve teklifler
- `POST /api/v1/jobs/:id/cancel` — sorguyu iptal et
- `POST /api/v1/jobs/:jobId/otp/:portalId` — kullanıcıdan alınan SMS kodunu ilet
- `GET /api/v1/jobs/:id/events` — SSE canlı durum akışı

## Test

```bash
node --test
```

## Güvenlik ve kullanım

- Panel HTTP Basic Authentication ile korunur.
- Portal oturumları ve iş geçmişi kalıcı `/app/data` volume'unda saklanır.
- CAPTCHA otomatik çözülmez; işlem manuel kontrol durumuna alınır.
- Yalnızca müşterinin açık onayı ve yetkili portal erişimi bulunan sorgularda kullanılmalıdır.
- Resmî API erişimi bulunan portal için API adaptörü tercih edilmelidir. Resmî API erişimi olmayan portallar, yalnızca kullanıcıya açık form ve yetkili hesap üzerinden çalıştırılır.
- Her portal canlı ortamda ayrı ayrı doğrulanmalıdır. `configured_unverified` etiketi form eşlemesinin bulunduğunu, gerçek teklifin doğrulandığını değil; `verified` ise canlı testin tamamlandığını belirtir.
