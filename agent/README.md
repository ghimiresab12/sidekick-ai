# LiveKit Agent

A voice AI project built with [LiveKit Agents for Python](https://github.com/livekit/agents) and [LiveKit Cloud](https://cloud.livekit.io/). This project is designed to work with coding agents like [Claude Code](https://claude.com/product/claude-code), [Cursor](https://www.cursor.com/), and [Codex](https://openai.com/codex/) — see [Coding agent support](https://docs.livekit.io/intro/coding-agents/) for setup tips.

> [!IMPORTANT]
> This project was converted to code from the LiveKit Agent Builder. The code is identical to production deployments from the builder. Follow the steps below to make it your own and deploy it to LiveKit Cloud. Once you do so, you can delete the version in the builder.

## Next steps

### Run and deploy your agent

**Get your agent running locally and in production:**

1. **Run locally**: Follow the [Quickstart](#quickstart) section below to set up your environment and test the agent
2. **Deploy to production**: See the [Deploy to production](#deploy-to-production) section for deployment options and best practices

### Quickstart

**Get up and running** so you can start customizing:

1. **Install dependencies:**
   ```console
   uv sync
   ```

2. **Set up your LiveKit credentials:**

   Sign up for [LiveKit Cloud](https://cloud.livekit.io/), then configure your environment. You can either:

   - **Manual setup**: Copy `.env.example` to `.env.local` and fill in:
     - `LIVEKIT_URL`
     - `LIVEKIT_API_KEY`
     - `LIVEKIT_API_SECRET`

   - **Automatic setup** (recommended): Use the [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/):
     ```bash
     lk cloud auth
     lk app env -w -d .env.local
     ```

3. **Download required models:**
   ```console
   uv run python src/agent.py download-files
   ```
   This downloads the model files used by the audio enhancement and noise cancellation plugins. [VAD](https://docs.livekit.io/agents/logic/turns/vad/) and [turn detection](https://docs.livekit.io/agents/logic/turns/turn-detector/) run in LiveKit Inference, so they need no local models.

4. **Test your agent:**
   ```console
   uv run python src/agent.py console
   ```
   This lets you speak to your agent directly in your terminal.

5. **Run for development:**
   ```console
   uv run python src/agent.py dev
   ```
   Use this when connecting to a frontend or telephony. This puts your agent into your LiveKit Cloud project, so use a different project if you don't want to affect production traffic.


## Customize your agent

Once your agent is running, enhance it for your use case:

- **Customize AI models**: Your agent uses a voice AI pipeline built on [LiveKit Inference](https://docs.livekit.io/agents/models/inference). More than 50 model providers are supported, including [Realtime models](https://docs.livekit.io/agents/models/realtime).

- **Add tests**: You can add a full test suite to your agent. See the [testing documentation](https://docs.livekit.io/testing/overview/) for more information.

- **Build reliable workflows**: For complex agents, use [tasks and handoffs](https://docs.livekit.io/agents/logic/workflows/) instead of long instruction prompts. This minimizes latency and improves reliability by structuring your agent into focused, reusable components.

### Get help from AI coding assistants

**Supercharge your development** with AI coding assistants that understand LiveKit. This project works seamlessly with [Claude Code](https://claude.com/product/claude-code), [Cursor](https://www.cursor.com/), [Codex](https://openai.com/codex/), and other AI coding tools.

For your convenience, LiveKit offers both a CLI and an [MCP server](https://docs.livekit.io/reference/developer-tools/docs-mcp/) that can be used to browse and search its documentation. The [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) (`lk docs`) works with any coding agent that can run shell commands. Install it for your platform:

**macOS:**

```console
brew install livekit-cli
```

**Linux:**

```console
curl -sSL https://get.livekit.io/cli | bash
```

**Windows:**

```console
winget install LiveKit.LiveKitCLI
```

Check your version with `lk --version` and update if needed. Once installed, your coding agent can search and browse LiveKit documentation directly from the terminal:

```console
lk docs search "voice agents"
lk docs get-page /agents/start/voice-ai-quickstart
```

**Install LiveKit's agent skills**: [Agent skills](https://docs.livekit.io/intro/coding-agents/#agent-skills) teach your coding agent how to build, debug, test, and deploy LiveKit agents, and point it to the latest documentation for API details. From this project's directory, install them for the coding agents on your machine:

```console
lk skills install
```

This also adds the LiveKit Docs MCP server to each coding agent's config. Run `lk skills update` to get the latest skills, and commit `skills-lock.json` along with them.

See the [Using coding agents](https://docs.livekit.io/intro/coding-agents/) guide for more details, including MCP server setup.

**Customize the AI assistant context**: The project includes an [AGENTS.md](AGENTS.md) file that guides AI assistants on how to work with this codebase. **Edit this file** to add your own project-specific context, patterns, and preferences. Learn more at [https://agents.md](https://agents.md).

## Frontend development

If you don't already have a frontend, use the following templates and guides to get started on one:

| Platform | Starter Template | What to customize |
|----------|----------|-------------|
| **Web** | [`livekit-examples/agent-starter-react`](https://github.com/livekit-examples/agent-starter-react) | React & Next.js—customize UI, add features, integrate with your backend |
| **iOS/macOS** | [`livekit-examples/agent-starter-swift`](https://github.com/livekit-examples/agent-starter-swift) | Native apps for iOS, macOS, visionOS—add platform-specific features |
| **Flutter** | [`livekit-examples/agent-starter-flutter`](https://github.com/livekit-examples/agent-starter-flutter) | Cross-platform—customize for Android, iOS, web, desktop |
| **React Native** | [`livekit-examples/voice-assistant-react-native`](https://github.com/livekit-examples/voice-assistant-react-native) | Mobile with Expo—add native modules, customize navigation |
| **Android** | [`livekit-examples/agent-starter-android`](https://github.com/livekit-examples/agent-starter-android) | Kotlin & Jetpack Compose—build Material Design UI |
| **Web Embed** | [`livekit-examples/agent-starter-embed`](https://github.com/livekit-examples/agent-starter-embed) | Widget for any website—customize styling, add to your site |
| **Telephony** | [Documentation](https://docs.livekit.io/telephony/) | Add phone calling—configure SIP, add call routing, customize prompts |

## Observability

LiveKit provides deep session insights for your agents through [Agent Observability](https://docs.livekit.io/testing/observability/). Monitor conversation quality, track latency metrics, and debug agent behavior in production.

## Deploy to production

To deploy your agent to production, you can use the LiveKit CLI:

```console
lk agent create
```

See the [deploying to production](https://docs.livekit.io/deploy/agents/) guide for detailed instructions and optimization tips.

## Join the LiveKit community

Join the [LiveKit Slack Community](https://livekit.io/join-slack) to get help from the LiveKit team and other developers.

## Sidekick transcript forwarding (entrypoint integration pending)

`transcript_forwarder.py` is offline-tested infrastructure, not an STT-enabled
replacement for the current exported `agent.py`. Damius owns that integration.
Do not treat the existing duplex assistant as quiet-mode Sidekick.

Configure the agent process with `SIDEKICK_BRIDGE_URL=http://127.0.0.1:8787` and
`SIDEKICK_AGENT_TOKEN`, alongside its existing LiveKit credentials. Never pass the
Node operator's `SIDEKICK_CONTROL_TOKEN` to Python. Run Node and Python on the same
host; a container or cloud agent's localhost is not the host bridge. Start Node
with `SIDEKICK_REASONING=mock SIDEKICK_VISION=none` for local verification.
The existing `npm run bridge` command builds Node before starting it; use a
separate workspace if another developer depends on the shared build directory.

The intended synchronous LiveKit event handler is:

```python
from sidekick_bridge import BridgeClient
from transcript_forwarder import TranscriptForwarder

# Inside the async job, before enabling audio input:
bridge = BridgeClient.from_env()
await bridge.start(ctx.room.name)
forwarder = TranscriptForwarder(bridge, max_pending=16)
forwarder.start()

@session.on("user_input_transcribed")
def on_transcript(event):
    forwarder.submit_final(event.transcript, is_final=event.is_final)
```

`submit_final` captures the exact session/generation/timestamp immediately and
returns whether it queued the item, NOT whether Node accepted it. Do not wrap this
callback in `create_task`, capture again in a worker, or retry failed sends.
Only final, nonempty text of at most 1,000 characters is queued. Overflow drops the
newest item. One worker owns at most 16 pending items plus one in flight. It does
not log text, credentials or exception messages. `last_result` is the latest
content-free BridgeClient result; `failed_count` counts unexpected send exceptions.

The operator must attest all participants agreed before Node accepts input.
BridgeClient cannot grant consent. The LiveKit adapter must separately keep STT
input disabled before consent and while paused, ended or capture polling is stale.
Reset STT streams at lifecycle changes and reject old-stream finals after resume:
the helper cannot identify pre-pause audio from a late callback. Keep transcripts
out of room text publication and recordings. Preserve one fixed Chert readiness
greeting, then remain quiet; this helper creates no speech or model requests.

On pause/end/replacement call `forwarder.clear_pending()` to release queued text.
Existing same-session contexts retain their original generation; replacement
sessions cannot receive them. Cancellation cannot undo a POST already accepted by
Node. Remove the event handler and stop input on shutdown, then await
`forwarder.close()` followed by `bridge.close()` in a job shutdown hook. The helper
does not close the caller-owned BridgeClient. Clean up initialization failures too.
Do not close these resources merely because `session.start()` returned.

### Offline checks

Python 3.13 is required by the project. After dependency installation is approved:

```bash
cd agent
uv sync --python 3.13 --group dev
uv run python -c 'import aiohttp; print(aiohttp.__version__)'
uv run pytest tests/test_transcript_forwarder.py tests/test_sidekick_bridge.py -ra
uv run pytest tests -ra
uv run ruff check src tests
uv run ruff format --check src tests
```

Confirm `AiohttpTransportTests` execute rather than skip. The forwarder tests need
only the standard library and use real BridgeClient with an in-memory transport:

```bash
python3 -B -m unittest discover -s agent/tests -p test_transcript_forwarder.py -v
```

The existing BridgeClient tests also run with unittest but create loopback test
servers. No LiveKit, Chert or provider access is required for either test module.

After Damius wires the entrypoint, verify one fixed greeting, no pre-consent input,
and one consented spoken sentence reaching Node. For example, register Alex,
confirm gaming, then say “Alex is responsible for left defense.” Correlate the
accepted observation ID with the projected speech event and role update. Browser
timelines intentionally hide raw transcript text. Repeat pause/resume, discard and
shutdown checks before claiming the real-call path works.
