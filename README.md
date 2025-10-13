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