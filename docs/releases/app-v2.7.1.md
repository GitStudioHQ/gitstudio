# GitStudio 2.7.1

### Fixed
- **GitHub sign-in works behind a proxy.** On a network that reaches the
  internet only through a proxy, Sign in with GitHub failed with "Couldn't
  reach GitHub", and so did every other GitHub view, the update check and
  cloud AI providers: those requests connected directly and never used the
  system proxy. They now go out the same way the rest of the app does,
  through the system proxy or PAC script. Local model servers (Ollama, LM
  Studio) are still reached directly. When a request does fail, the message
  now says why and which address, for example "Couldn't reach GitHub
  (ERR_PROXY_CONNECTION_FAILED) — github.com/login/device/code"
  (#133).
