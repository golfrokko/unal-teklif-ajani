# Ünal Sigorta Teklif Ajanı

Easypanel üzerinde çalışan, yetkili sigorta portallarındaki trafik tekliflerini tek kuyrukta toplayan çevrimiçi sorgu ajanıdır.

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
HEADLESS=true
```

`PANEL_PASSWORD` yalnızca Easypanel içindeki Environment alanına yazılmalı; GitHub'a kaydedilmemelidir.

## Güvenlik ve kullanım

- Panel HTTP Basic Authentication ile korunur.
- Portal oturumları ve iş geçmişi `/app/data` altında saklanır.
- CAPTCHA otomatik çözülmez; işlem manuel kontrol durumuna alınır.
- Yalnızca müşterinin açık onayı ve yetkili portal erişimi bulunan sorgularda kullanılmalıdır.
- Her portalın giriş akışı canlı ortamda ayrı ayrı doğrulanmalıdır; portal değişiklikleri adaptör güncellemesi gerektirebilir.
