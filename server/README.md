# NEON TANKS — سرور چندنفره (Cloudflare Workers)

سرور اسکواد/چندنفره‌ی بازی روی **Cloudflare Workers + Durable Objects** اجرا می‌شود — بدون نیاز به VPS و در پلن رایگان کلادفلر قابل استفاده است.

## استقرار (Deploy)

```bash
npm install -g wrangler
cd server
wrangler login
wrangler secret put BOT_TOKEN     # توکن ربات تلگرام (از BotFather)
wrangler deploy
```

خروجی deploy یک آدرس مثل `https://neon-tanks-mp.<account>.workers.dev` می‌دهد.

## اتصال بازی به سرور

در `tank.html` داخل `<head>` این سه متا‌تگ را اضافه/تنظیم کنید:

```html
<meta name="mp-server" content="wss://neon-tanks-mp.<account>.workers.dev/ws">
<meta name="mp-bot"    content="YourBotUsername">
<meta name="mp-app"    content="play">
```

- `mp-server`: آدرس WebSocket ورکر (مسیر `/ws`)
- `mp-bot`: یوزرنیم ربات (برای ساخت لینک دعوت `t.me/bot/app?startapp=CODE`)
- `mp-app`: short name مینی‌اپ که در BotFather ساخته‌اید (`/newapp`)

اگر متاتگ‌ها نباشند، بازی کاملاً تک‌نفره و بدون خطا کار می‌کند.

## راه‌اندازی Mini App تلگرام

1. در BotFather: `/newbot` → توکن را بردارید.
2. `/newapp` → ربات را انتخاب کنید، short name بدهید (مثلاً `play`) و URL بازی را بدهید.
3. بازی (`tank.html`) را روی **Cloudflare Pages** (رایگان) یا GitHub Pages میزبانی کنید — باید HTTPS باشد.
4. لینک بازی: `https://t.me/YourBot/play`

## معماری

- هر اتصال WebSocket به یک Durable Object (کلاس `SquadRooms`) می‌رود.
- `initData` تلگرام با HMAC-SHA256 و توکن ربات **در سمت سرور** اعتبارسنجی می‌شود؛ هویت بازیکن همان اکانت تلگرام است.
- اسکوادها کدهای ۵حرفی دارند؛ حداکثر ۴ عضو؛ snapshot موقعیت‌ها با نرخ 10Hz برای اعضای اسکواد broadcast می‌شود.
- رویدادها (شکست باس و…) بین اعضا relay می‌شود؛ پاداش تیمی سمت کلاینت اعمال می‌شود.

## محدودیت‌های پلن رایگان کلادفلر (کافی برای شروع)

- 100,000 درخواست در روز + Durable Objects با پشتوانه SQLite در پلن رایگان.
- WebSocket Hibernation باعث می‌شود اسکوادهای بیکار تقریباً هزینه‌ای نداشته باشند.
- اگر بازیکنان زیاد شدند، می‌توان هر اسکواد را به DO جداگانه شارد کرد (تغییر یک خط routing، بدون تغییر پروتکل).
