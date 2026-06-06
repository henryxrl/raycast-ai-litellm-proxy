# Raycast AI LiteLLM Proxy

Use any LiteLLM model in Raycast AI without a subscription.

Fork of [d-cu/raycast-ai-litellm-proxy](https://github.com/d-cu/raycast-ai-litellm-proxy) with pre-built images published to [GitHub Container Registry](https://github.com/henryxrl/raycast-ai-litellm-proxy/pkgs/container/raycast-ai-litellm-proxy).

## Changelog

### 0.0.4

- Fix parsing LiteLLM `/model/info` responses where numeric fields are `null`
- Fix fallback when strict parsing fails so detailed model entries are not misread as `/v1/models` entries

### 0.0.3

- Prefer LiteLLM `/model/info` metadata for vision detection when the proxy `API_KEY` can access it (`supports_vision: true`)
- Fall back to name-based vision matching when `/model/info` is unavailable (e.g. virtual keys limited to `llm_api_routes`)
- Try both `/v1/model/info` and `/model/info`, and resolve `/v1/models` correctly when `BASE_URL` ends with `/v1`

### 0.0.2

- Improved vision capability detection so Raycast can enable image input for more LiteLLM models
- Models whose names include `vision` or `-vl` (e.g. `qwen36-35b-mtp-vision`) are now reported with the `vision` capability via `/api/show`
- Added broader name-based matching for common vision model families (Qwen-VL, DeepSeek-VL, Claude 4, Gemini, LLaVA, and others)
- Merged LiteLLM capability flags with name-based detection instead of relying on a single source

## Quick Start

**Prerequisites**: Docker + running LiteLLM server

1. **Clone and setup**:

   ```bash
   git clone https://github.com/henryxrl/raycast-ai-litellm-proxy.git
   cd raycast-ai-litellm-proxy
   cp .env.example .env
   ```

2. **Configure** (edit `.env`):

   ```bash
   API_KEY=your-litellm-api-key
   BASE_URL=http://host.docker.internal:4000/v1
   ```

   > **Vision models**: For metadata-based vision detection, the proxy `API_KEY` must be able to call LiteLLM `/model/info`. Keys limited to `llm_api_routes` cannot access that endpoint; the proxy will fall back to name-based matching (e.g. model names containing `vision` or `-vl`).
   >
   > **Common fix**: If `host.docker.internal` doesn't work, use your IP:
   >
   > ```bash
   > BASE_URL=http://192.168.1.X:4000/v1  # Replace X with your IP
   > ```

3. **Start proxy** (pulls pre-built image from GHCR):

   ```bash
   docker compose pull
   docker compose up -d
   ```

   Or run without cloning — create a `.env` file and use the image directly:

   ```bash
   docker run -d --name raycast-ai-proxy \
     --restart unless-stopped \
     -p 11435:3000 \
     --add-host host.docker.internal:host-gateway \
     --env-file .env \
     ghcr.io/henryxrl/raycast-ai-litellm-proxy:latest
   ```

4. **Configure Raycast**:

   In Raycast Settings → **AI**:

   **Local Models section:**
   - Set **Ollama Host**: `localhost:11435`
   - Click **Sync Models** to discover your LiteLLM models

   **Experiments section:**
   - Scroll down and enable **AI Extensions for Ollama Models**

**Done!** Your LiteLLM models now appear in Raycast AI.

## Development

To build and run from source instead of the published image:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Pushes to `main` that touch `Dockerfile`, `src/`, or dependencies automatically build and publish `ghcr.io/henryxrl/raycast-ai-litellm-proxy:latest` via GitHub Actions.

## Troubleshooting

| Issue | Solution |
| ----- | -------- |
| `pull access denied` or auth errors | Log in: `docker login ghcr.io` — or set the [GHCR package](https://github.com/henryxrl/raycast-ai-litellm-proxy/pkgs/container/raycast-ai-litellm-proxy) to **Public** |
| Only see fallback models | Replace `host.docker.internal` with your IP in `.env` |
| Connection refused | Use `BASE_URL=http://192.168.1.X:4000/v1` |
| No models appear | Verify `API_KEY` and restart: `docker compose restart` |
| Stale image after updates | `docker compose pull && docker compose up -d` |
| Raycast won't accept images | Pull latest image, restart proxy, then **Sync Models** in Raycast. Verify with: `curl -s http://localhost:11435/api/show -H "Content-Type: application/json" -d '{"model":"YOUR_MODEL"}' \| jq '.capabilities'` — response should include `"vision"`. If using a restricted virtual key, either grant `/model/info` access or use a model name that includes `vision` / `-vl` |

## Configuration

Optional `.env` settings:

```bash
PORT=3000                        # Proxy port (default: 3000)
MODEL_REFRESH_INTERVAL=300000    # Model refresh interval (default: 5 min)
PING_INTERVAL=10000              # Connection keepalive (default: 10 sec)
```

---

> **Built on**: [@miikkaylisiurunen](https://github.com/miikkaylisiurunen)'s excellent [raycast-ai-openrouter-proxy](https://github.com/miikkaylisiurunen/raycast-ai-openrouter-proxy) — Thank you for the foundation! Enhanced for LiteLLM with performance and reliability improvements.
