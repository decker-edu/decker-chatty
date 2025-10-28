# Description

Small script that creates a proxy that relays messages to ChatGPT using a provided API Key.

Used by decker's `chatty` plugin to allow chatting with Prof. Bot.

# Setup

Edit `config.json`.

``` bash
npm install
npm start
```

Configure your reverse proxy to relay `https://` requests to the running service.

# Running as a systemd service

To run the server as a systemd service that starts automatically on boot:

## Installation

``` bash
sudo cp decker-chatty.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable decker-chatty.service
sudo systemctl start decker-chatty.service
```

## Usage

``` bash
# Check service status
sudo systemctl status decker-chatty.service

# View logs
tail -f chatty.log

# Stop the service
sudo systemctl stop decker-chatty.service

# Restart the service
sudo systemctl restart decker-chatty.service

# Disable auto-start on boot
sudo systemctl disable decker-chatty.service
```

The service logs all output to `chatty.log` in the project directory.