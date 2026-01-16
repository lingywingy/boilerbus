# BoilerBus ![License](https://img.shields.io/badge/license-MIT-blue.svg)

A Progressive Web App (PWA) for real-time Purdue University bus tracking. View nearby stops, live ETAs, bus locations on an interactive map, and get walking directions.

I really dislike the official bus app, so I decided to reverse engineer the API endpoints for bus tracking and route info and make my own frontend. 

It felt like they intentionally designed it to be as confusing and slow to navigate as possible, requiring you to log in to your Purdue account and go through MFA just to check when the bus is coming.

> **Disclaimer:** This project is **NOT-AFFILIATED** with or sponsored by Purdue University, CityBus, or Liftango.

## Install as App

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

## Documentation

- **[Self-Hosting Guide](../../wiki/Self-Hosting)** 
- **[Liftango API Documentation](../../wiki/Liftango-API)** 

## Quick Start (Local Development)

```bash
# Clone the repository
git clone https://github.com/lingywingy/BoilerBus.git
cd BoilerBus

# Start the development server (includes CORS proxy)
python server.py

# Open http://localhost:8085
```

No build step required - this is vanilla JavaScript with static hosting.

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
