# Appdock server

A small Node.js server that serves the Appdock site and stores apps that visitors add, so everyone sees the same catalog. It uses only built-in Node modules, so there is nothing to install.

## Run it

    node server.js

Open http://localhost:3000. Needs Node 18 or newer.

## Settings (environment variables)

- PORT: port to listen on. Default 3000.
- DATA_DIR: folder where apps.json is saved. Default ./data. Point it at a persistent disk on your host.
- ADMIN_TOKEN: a secret you choose. It lets you remove any app (see below). Leave it unset to turn this off.
- TRUST_PROXY: set to 0 if the server is not behind a proxy or load balancer. Default is to read the client address from X-Forwarded-For.

## How it works

- GET /api/apps lists added apps.
- POST /api/apps adds one. The server checks every field and returns a private key. The page keeps that key in the visitor's browser, so only they can remove that app.
- DELETE /api/apps/:id removes an app. It needs the owner's key (X-Owner-Key header) or your admin token (X-Admin-Token header).

Remove any app as admin:

    curl -X DELETE https://YOUR-SITE/api/apps/APP_ID -H "X-Admin-Token: YOUR_TOKEN"

Limits: 10 submissions per address per hour, 2000 apps total, 20 KB per request.

## Hosting

This needs a host that runs Node (a VPS, Render, Railway, Fly.io and similar). A static host such as EdgeOne Pages hosting only files cannot run it. Pick a host with a disk that survives restarts and set DATA_DIR to it, or the saved apps are lost when the server restarts.
