# BoilerBus

A Progressive Web App (PWA) for real-time Purdue University bus tracking. View nearby stops, live ETAs, bus locations on an interactive map, and get walking directions.

I really dislike the official bus app, so I decided to make my own. The API endpoints for bus tracking and route info don't require any authentication to poll and I was able to figure it out with some poking. It seemed to me like they intentionally designed it to be as confusing and slow to navigate as possible, and I really hated how you had to use your Purdue login just to see where the bus is. 

![License](https://img.shields.io/badge/license-MIT-blue.svg)

> **Disclaimer:** This project is NOT-AFFILIATED with or sponsored by Purdue University, CityBus, or Liftango.

## 📱 Install as App

BoilerBus is a Progressive Web App (PWA) that can be installed on your phone's home screen for quick access, just like a native app.

### iOS (Safari)

1. Open Safari on your iPhone
2. Navigate to [https://lingywingy.github.io/boilerbus/](https://lingywingy.github.io/boilerbus/)
3. Tap the **Share** button
4. Scroll down and tap **Add to Home Screen**
5. Optionally edit the name, then tap **Add** in the top right
6. The BoilerBus icon will appear on your home screen!

### Android (Chrome)

1. Open Chrome on your Android device
2. Navigate to [https://lingywingy.github.io/boilerbus/](https://lingywingy.github.io/boilerbus/)
3. Tap the **Menu** button (three dots) in the top right
4. Tap **Install app** or **Add to Home screen**
5. Tap **Install** in the popup
6. The BoilerBus icon will appear on your home screen!

## API Info

need to update placeholder once i write the docs wiki page
If you'd like to make your own project that pulls data from Purdue's campus transit network, you can find details on the Liftango API [placeholder](here).

## Development/Self-Hosting Quick Start

### 1. Deploy the CORS Proxy (Required)

The Liftango API doesn't allow cross-origin requests, so you need a proxy. Cloudflare Workers offers a generous free tier (100k requests/day).

1. Sign up at [Cloudflare](https://dash.cloudflare.com/sign-up) (free)
2. Go to **Workers & Pages** > **Create application** > **Create Worker**
3. Name your worker (e.g., `purdue-transit-proxy`)
4. Replace the default code with the contents of [`cloudflare-worker.js`](cloudflare-worker.js)
5. Click **Save and Deploy**
6. Note your worker URL: `https://purdue-transit-proxy.YOUR-SUBDOMAIN.workers.dev`

#### Optional: Add Rate Limiting

To protect your proxy from abuse:

1. In your worker, go to **Settings** > **Variables**
2. Click **Add binding** under Rate Limiting
3. Name: `RATE_LIMITER`
4. Configure: 100 requests per 60 seconds
5. Save

### 2. Configure the App

Edit [`config.js`](config.js) and set your CORS proxy URL:

```javascript
var APP_CONFIG = {
    CORS_PROXY_URL: 'https://purdue-transit-proxy.YOUR-SUBDOMAIN.workers.dev',
    // ... other settings
};
```

### 3. Deploy to GitHub Pages

1. Fork this repository
2. Edit `config.js` with your worker URL
3. Go to **Settings** > **Pages**
4. Set source: **Deploy from a branch** > **main** > **/ (root)**
5. Save - your app will be live at `https://lingywingy.github.io/BoilerBus/`

## Local Development

For local development, you don't need to configure a CORS proxy. The included Python server handles proxying:

```bash
# Clone the repository
git clone https://github.com/lingywingy/BoilerBus.git
cd BoilerBus

# Start the development server
python server.py

# Open in browser
# http://localhost:8085
```

The local server includes a built-in CORS proxy, so leave `CORS_PROXY_URL` empty in `config.js` for local development.

## Project Structure

```
BoilerBus/
├── index.html              # Main HTML file
├── app.js                  # Application logic (~1700 lines)
├── config.js               # Configuration (CORS proxy URL, settings)
├── styles.css              # Styles with Purdue theme
├── sw.js                   # Service worker for offline support
├── manifest.json           # PWA manifest
├── cloudflare-worker.js    # CORS proxy code for Cloudflare Workers
├── server.py               # Local development server with proxy
└── icons/                  # App icons
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This project is an independent, open-source effort and is **not affiliated with, endorsed by, or sponsored by Purdue University, CityBus, or Liftango**. It is provided "as is" without warranty of any kind. Use at your own discretion.

## Acknowledgments

- [Liftango](https://www.liftango.com/) for the public API
- [Cloudflare](https://www.cloudflare.com/) for free worker hosting
- [SVG Repo](https://www.svgrepo.com/svg/447922/bus) for the app icon
- [Leaflet](https://leafletjs.com/) for interactive maps
- [CartoDB Dark Matter](https://carto.com/basemaps/) for map tiles
- [Anthropic](https://www.anthropic.com/) for AI tools that were used to build this project
