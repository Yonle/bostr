# Bostr
A nostr relay bouncer.

## What is this?
**Bostr** is a multi nostr relay **proxy** that were serving as a nostr relay.

## Why?
Nostr relays is a bunch of dummy servers that store user events. Normally nostr clients usually connects to more than 5-10 relays to receive and transmit events.

Due to it's nature that connects to more than just a single relay, **Client bandwidth usage is high.** And because of this, Nostr bandwidth usage is not really recommended for some users, notably **mobile data users.**

This project solve the problem by **reducing** the number of connected relays, at the same time **proxying** multiple relays in a single socket to nostr client.

## How it works?
![How it works](img/how_it_works.png)

## Installation
- [NodeJS](https://nodejs.org) (v16 or up)
- libsqlite installed in your system
- A fast internet connection

```
git clone https://github.com/Yonle/bostr
cd bostr
npm i
```

Rename `config.js.example` as `config.js`, Start editing the file and fill some required fields accordingly to your needs. You could either run it for everyone or only for yourself.

## Running
```
node index.js
```

Or run in background with `tmux`:

```
tmux new -d "node index.js"
```

When configuring reverse proxy, Ensure that `x-forwarded-proto` header was set as `https`.

## Environment Variable
- `CLUSTERS` - Run Bostr with specified numbers of clusters.
- `LOG_ABOUT_RELAYS` - Whenever to log about relay connections

## Docker
### Quick Run
```
git clone https://github.com/Yonle/bostr
cd bostr
docker build -t bostr:local .
docker run --rm --name bostr -p 8080:8080 -v ./config.js:/usr/src/app/config.js bostr:local
```

**Note:** You will need to edit `config.js` before running the bouncer.

## License

Copyright 2023 Yonle <yonle@lecturify.net>

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
