# Bostr
A nostr bouncer

## What is this?
It's a bouncer for Nostr relays

## Why?
Nostr relays is bunch of dummy servers and usually connects to more than 5-10 relays to work properly.

Due to it is nature to connect to more than two or three relays, This caused a issue such as mobile data bandwidth drained drastically, and similiar


This project serve the purpose as a bouncer to reduce client bandwidth usage.

## Installation
- NodeJS (+v14)
- Libsqlite installed in your system
- A fast internet connection

```
git clone https://github.com/Yonle/bostr
cd bostr
npm i
```

Rename `config.js.example` as `config.js`, Start editing the file and fill some required fields accordingly to your needs.

## Running
```
node index.js
```

Or run in background with `tmux`:

```
tmux new -d "node index.js"
```

## Environment Variable
- `CLUSTERS` - Run Bostr with specified numbers of clusters.
- `IN_MEMORY` - Store temporary data in memory (RAM) instead of disk.
- `LOG_ABOUT_RELAYS` - Whenever to log about relay connections

## License

Copyright 2023 Yonle <yonle@lecturify.net>

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
