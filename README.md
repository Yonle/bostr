# Bostr
A nostr relay bouncer.

## What is this?
**Bostr** is an nostr relay aggregator **proxy** that acts like a regular nostr relay. It connects to multiple configured relays to exchange data (events). This project purpose is saving mobile user's bandwidth when using nostr.

## Why?
Nostr relays is a bunch of dummy servers that store user events. Normally nostr clients connects to more than 5-10 relays to receive and transmit events.

Due to it's nature that connects to more than just a single relay, It's transmitting and retrieving the same event across relays over and over, Which then makes the **client bandwidth usage to be high.** And because of this, Nostr bandwidth usage is not really recommended for some users, notably **mobile data users.**

This project solve the problem by **proxying** multiple relays in a single socket while **not forwarding the same event** to the client.

## How it works?
![How it works](img/how_it_works.png)

In order to make this work properly, A nostr client should only connect to a single bostr relay.

## Installation
- [NodeJS](https://nodejs.org) (v18 or up) or [Bun runtime](https://bun.sh)
- A working reverse proxy like [nginx](https://nginx.org) or [caddy](https://caddyserver.com)
- A fast internet connection

You could set up an bostr bouncer by installing [Bostr CLI](#bostr-cli), or setting up via [The Source Code](#source-code), or via [Docker](#docker).

**Tip:** When dependencies installation is failed due to failed compilation of `bufferutil` or `utf-8-validate` packages, Run `npm install` with `--omit=optional` (Example: `npm install --omit=optional -g bostr`).

Installation Methods
- [Bostr CLI](#bostr-cli)
- [Source code](#source-code)
- [Docker](#docker)
- [Bun runtime](#bun-runtime)

### Bostr CLI
Install bostr via `npm`:
```
npm install -g bostr
```

or via git:

```
npm install -g https://codeberg.org/Yonle/bostr.git
```

You will need to make config with the following command:
```
bostr makeconf bostr_config.js
```

Edit `bostr_config.js` (Could be modified) with your file editor and fill some required fields accordingly to your needs. You could run it for everyone or only for yourself.

#### Running
After you finished editing the config file, You could start bostr with the following command:
```
bostr start bostr_config.js
```

Or run in background with `tmux`:

```
tmux new -d "bostr start bostr_config.js"
```

When configuring reverse proxy, Ensure that `x-forwarded-proto` header was set as `https`.

### Source code

```
git clone -b stable https://codeberg.org/Yonle/bostr
cd bostr
npm install
```

Rename `config.js.example` as `config.js`, Start editing the file and fill some required fields accordingly to your needs. You could run it for everyone or only for yourself.

#### Running
```
node index.js
```

Or run in background with `tmux`:

```
tmux new -d "node index.js"
```

When configuring reverse proxy, Ensure that `x-forwarded-proto` header was set as `https`.

### Docker
```
git clone https://codeberg.org/Yonle/bostr
cd bostr
cp config.js.example config.js
```

You will need to edit `config.js` before running the bouncer.

Then, you will need to edit `compose.yaml` to override the forwarded port to match with the one in `config.js`.

#### Running
```
docker build -t bostr:local .
docker run --rm --name bostr -p 8080:8080 -v ./config.js:/usr/src/app/config.js bostr:local
```

### Bun runtime
```
git clone -b stable https://codeberg.org/Yonle/bostr
cd bostr
bun install
```

Rename `config.js.example` as `config.js`, Start editing the file and fill some required fields accordingly to your needs. You could run it for everyone or only for yourself.

#### Running
```
bun run index.js
```

Or run in background with `tmux`:

```
tmux new -d "bun run index.js"
```

When configuring reverse proxy, Ensure that `x-forwarded-proto` header was set as `https`.

## Environment Variables
You could specify the following environment variables to override the current settings:

- `CLUSTERS` - Run Bostr with specified numbers of clusters.
- `LOG_ABOUT_RELAYS` - Whenever to log about relay connections.

## License

Copyright 2024 Yonle <yonle@lecturify.net>

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
