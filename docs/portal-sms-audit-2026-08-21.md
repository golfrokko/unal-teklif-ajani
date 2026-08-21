# Portal SMS incelemesi — 21 Ağustos 2026

Bu inceleme gerçek müşteri verisi göndermeden, portalların herkese açık ilk teklif adımları üzerinden yapılmıştır. Telefon alanı tek başına SMS kanıtı sayılmamıştır. `Belirsiz`, kontrollü bir gerçek sorgu yapılmadan güvenli biçimde sınıflandırılamayan portal demektir.

| Portal | SMS politikası | Salt okunur inceleme sonucu |
|---|---|---|
| Sigorta Lion | Oturum başına bir kez | Kullanıcı gözlemi; bulut tarayıcıda Cloudflare engeli |
| Bi Tıkla Sigorta | Belirsiz | Cloudflare erişim engeli |
| SigortaBaz | Belirsiz | Dış erişimde 502 |
| SigortaMobil | Belirsiz | Cloudflare erişim engeli |
| Taşaltı Teklif | Belirsiz | Cloudflare erişim engeli |
| Sert Sigorta | Belirsiz | Cloudflare erişim engeli |
| Ne Pratik Sigorta | Belirsiz | Cloudflare erişim engeli |
| İskenderun Teklif | Belirsiz | Cloudflare erişim engeli |
| Sigortam Milli | Belirsiz | Ana sayfa açıldı; teklif iframe'i Taşaltı/Cloudflare |
| Sigortam.net | Belirsiz | İlk formda telefon alanı var, açık SMS ifadesi yok |
| Sigortaladım | Belirsiz | İlk formda telefon alanı var; üye girişi SMS kodlu, teklif akışı doğrulanmadı |
| Koalay | Belirsiz | Bulut tarayıcıda zaman aşımı |
| Enuygun Sigorta | Her sorguda SMS | Resmî trafik formu SMS doğrulama kodu gönderileceğini açıkça yazıyor |
| Sigortambir | Belirsiz | İlk formda telefon alanı var, açık SMS ifadesi yok |
| Sigorta7 | Belirsiz | Sayfa içeriği yüklenmedi |
| Sigorta Yeri | Belirsiz | Bulut tarayıcıda zaman aşımı |
| Sigorta.la | Belirsiz | Bulut tarayıcıda zaman aşımı |
| Dijipol | Belirsiz | Trafik formu açıldı; telefon alanı var, açık SMS ifadesi yok |
| HangiKredi Sigorta | Belirsiz | Sayfa içeriği yüklenmedi |
| Enpara Sigorta | Belirsiz | Koddaki URL 404 dönüyor |
| Hepiyi | Belirsiz | Teklif içeriği yüklenmedi |
| Quick Sigorta | Belirsiz | Teklif formunda telefon ve reCAPTCHA var; açık SMS ifadesi yok |
| Sompo Sigorta | Belirsiz | Bulut tarayıcıda zaman aşımı |
| Ethica Sigorta | Belirsiz | Dış erişimde 502 |
| PoliçeKes | Belirsiz | Site kabuğu açıldı; trafik formu görünmedi |

## Güvenli çalışma kuralı

- `per_query` ve `session_once` portallar, **Yalnız SMS'siz** modunda tarayıcı açılmadan atlanır.
- CAPTCHA otomatik aşılmaz; manuel işlem gerektirir.
- `none` yalnız gerçek sorguda SMS gönderilmediği gözlendikten sonra atanır.
