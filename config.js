"use strict";

// Bostr config

module.exports = {
  // Server listener [Required]
  address: "0.0.0.0",
  port: "8080",

  // Standalone HTTPS server. Normally bostr is accepting unsecured connections.
  // Specifying the absolute path of the private key/certificate will make bostr to only accept secured connections.
  //
  // Tip: You do not need this if you are running bostr behind reverse proxy.
  https: {
    privKey: "",
    certificate: "",
    ticketKey: ""
  },

  // Clusters (default: 1)
  //
  // Every single clusters has additional 1 running worker,
  // Which making bostr running at 2 threads by default.
  //
  // You may increase this value if:
  // - You want to use more threads/cores in your server
  // - You got heavy traffics / many clients
  // 0 (auto) will determine based of how many parallelism / cores available in the system.
  clusters: 1,

  // Numbers of idle sessions to be created
  // Default: 1
  idle_sessions: 1,

  // Log about bouncer connection with relays?
  log_about_relays: false,

  // Use deflate compression for websocket.
  // This could save user bandwidth.
  perMessageDeflate: true,

  // Reject scraper requests.
  // This only checks whenever client respond to bouncer's AUTH.
  //
  // NOTE: - Require NIP-42 compatible nostr client.
  //       - This will also block unauthorized EVENT.
  noscraper: false,

  // Time before reconnect to relays in milliseconds.
  reconnect_time: 5000,

  // Ratelimit expiration after ratelimit from upstream relay in miliseconds.
  // Setting as 0 will disable ratelimit handling.
  upstream_ratelimit_expiration: 10000,

  // Maximum incoming connections per IP.
  // By default, This is Infinity. Change the value as Integer (number) to override.
  max_conn_per_ip: Infinity,

  // Maximum subscriptions that client could open.
  // Setting as -1 will disable max subscription limit.
  max_client_subs: -1,

  // Maximum Known Events
  // Used for knowing what events has been forwarded to client in order to prevent duplicates to be forwarded.
  // This is only storing event IDs into memory (RAM), not an entire event blob.
  //
  // Setting as 0 will store known events to memory without limit until the subscription is closed.
  // Reduce this value if memory usage is high. But don't go too low as duplicates will be forwarded to client.
  max_known_events: 1000,

  // Wait for every connected relays send EOSE.
  // Could improve accuracy on received events.
  //
  // Depending on your configured relays,
  // It may could cause loading problems in client due to slow EOSE from bouncer.
  // You could try fix this by changing <max_eose_score> value.
  wait_eose: true,

  // Pause an subscription from receiving further events after reached to <filter.limit>
  // Enabling this could fix bandwidth issues at certain client.
  // This is also known as save mode.
  //
  // You may also need to adjust <max_eose_score>.
  pause_on_limit: false,

  // Maximum of received EOSE from relays to send EOSE to client.
  // Normally, waiting EOSE from 3 relays should be enough. Leaving it with 0 equals wait for every established relays.
  // NOTE: Please adjust this max score correctly with your configured relays.
  //       If you only setted up 3 relays, Set the <max_eose_score> as 0.
  // Tip : The bigger = The more accurate EOSE, The less = EOSE sent way earlier.
  max_eose_score: 0,

  // A whitelist of users public keys who could use this bouncer.
  // Leaving this empty will allow everyone to use this bouncer.
  // NOTE: - Require NIP-42 compatible nostr client.
  //         You may use <allowed_event_authors> instead if your client does not support NIP-42.
  authorized_keys: [
    // "npub1m78s5eqv8l7snc5nnxdvlgue6pt5epgplndtem99quhwyptas7jss2qx53",
    // "pubkey-in-hex",
    // "npub ....",
    // ....
  ],

  // A whitelist of allowed event owner.
  // Leaving this empty will allow everyone to publish events from anyone to this bouncer.
  allowed_publishers: [
    // "pubkey-in-hex",
    // "npub ....",
    // ....
  ],

  // A blacklist of blocked event owner.
  blocked_publishers: [
    // "pubkey-in-hex",
    // "npub ....",
    // ....
  ],

  // Block incomming websocket connections from the following hosts.
  blocked_hosts: [
    // "127.0.0.1",
    // "127.0.0.2",
    // "::1",
    // "::2",
    // ....
  ],

  // Used for accessing NIP-42 protected events from certain relays.
  // It could be your key. Leaving this empty completely disables NIP-42 function.
  //
  // You could use this function even as a public bouncer.
  // There are no security risk as it utilize NIP-42 to recognize client public key.
  //
  // NOTE: - Require NIP-42 compatible nostr client
  private_keys: {
    // "pubkey-in-hex": "privatekey-in-hex",
    // "pubkey-in-hex": "nsec ....",
    // "npub ....": "privatekey-in-hex",
    // "npub ....": "nsec ...."
  },

  // Server information.
  // Only for when nostr client requesting server information.
  server_meta: {
    "contact": "unset",
    "pubkey": "npub1m78s5eqv8l7snc5nnxdvlgue6pt5epgplndtem99quhwyptas7jss2qx53",
    "description": "Nostr relay bouncer",
    "name": "Bostr",
    "software": "git+https://github.com/Yonle/bostr",
    "canonical_url": "wss://bostr.example.com",

    // Some nostr client may read the following for compatibility check.
    // You may change the supported_nips to match with what your relays supported.
    "supported_nips": [1,2,9,11,12,15,16,20,22,33,40,42,50],
    // "icon_url": ""
  },

  // Path to favicon file.
  favicon: "",

  // Nostr relays to bounce [Required]
  relays: [
    "wss://relay-jp.nostr.wirednet.jp",
    "wss://nostr.fediverse.jp",
    "wss://nrelay-jp.c-stellar.net",
    "wss://r.kojira.io",
    "wss://nostrja-kari.heguro.com",
    "wss://relay-jp.shino3.net",
    "wss://nostr.holybea.com",
    "wss://relay-jp.nostr.moctane.com",
    "wss://nostream.ocha.one",
    // "wss://example3.com",
    // ...and so on
  ],
  // Unless you use this bouncer only for load balancing,
  // You could empty <relays> as long <loadbalancer> is not empty.

  // Cache relays - Store received events to cache relay(s) (Optional).
  // Could improve the speed of event deliveries.
  //
  // Ensure that the cache relay does not have websocket ratelimit being set.
  // CAUTION: - Cache relay is intensive in storing events.
  //          - Only works best with only 1 cache relay.
  //          - Things may not work properly if you configure more than just a single cache relays.
  cache_relays: [
    // "ws://localhost:3000"
  ],

  // Load balancer - Load balance this bouncer (Optional)
  //
  // You could make this bouncer to connect to other bouncer in order to save this server loads.
  // It's suggested that the following bouncers does not have `noscraper` or `authorized_keys` being set.
  //
  // NOTE: Ensure that these bouncers has the same relays list as the other bouncers did,
  //       Otherwise the listing page of this http server will be inaccurate.
  //
  // NOTE: Ensure that these bouncer's <max_conn_per_ip> is set as "Infinity"
  //       If you want to handle <max_conn_per_ip>, Set in here instead
  //
  // ATTENTION: This load balancer is ONLY designed for bouncers in mind.
  //            If you REALLY want to use it with your relays, Ensure that
  //            Every single relays that you provide below is using the same database as the others did.
  loadbalancer: [
    // "wss://bostr1.example.com",
    // "wss://bostr2.example.com",
    // "wss://bostr3.example.com",
    // ...and so on
  ]
}
