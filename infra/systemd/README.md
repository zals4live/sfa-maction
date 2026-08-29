# Systemd Service Units — KF Maction v2.0

Production systemd service unit files for managing Maction services on AWS EC2 (Ubuntu).

## Services

| Unit File | Description | Port |
|-----------|-------------|------|
| `maction-api.service` | Elysia.js API server (Bun runtime) | 127.0.0.1:3000 |
| `maction-portal.service` | Nuxt 4 SSR Web Portal (Node.js) | 127.0.0.1:3001 |

Both services bind to localhost only. Nginx handles public-facing traffic, SSL termination, and reverse proxying.

## Prerequisites

1. Create a dedicated service user:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin maction
```

2. Deploy application files to `/opt/maction/`:

```bash
sudo mkdir -p /opt/maction/{api-server,web-portal}
sudo chown -R maction:maction /opt/maction
```

3. Install runtimes:
   - **Bun** (for API server): https://bun.sh/docs/installation
   - **Node.js 20+** (for Nuxt SSR): via NodeSource or nvm

## Installation

```bash
# Copy unit files
sudo cp maction-api.service /etc/systemd/system/
sudo cp maction-portal.service /etc/systemd/system/

# Reload systemd daemon
sudo systemctl daemon-reload

# Enable services to start on boot
sudo systemctl enable maction-api.service maction-portal.service

# Start services
sudo systemctl start maction-api.service
sudo systemctl start maction-portal.service
```

## Environment Files

Each service loads secrets from an `.env` file in its working directory:

- `/opt/maction/api-server/.env` — DATABASE_URL, REDIS_URL, JWT_SECRET, AWS credentials
- `/opt/maction/web-portal/.env` — NUXT_PUBLIC_API_BASE, session config

Secure the env files:

```bash
sudo chmod 600 /opt/maction/api-server/.env
sudo chmod 600 /opt/maction/web-portal/.env
sudo chown maction:maction /opt/maction/api-server/.env
sudo chown maction:maction /opt/maction/web-portal/.env
```

## Management Commands

```bash
# Check status
sudo systemctl status maction-api.service
sudo systemctl status maction-portal.service

# View real-time logs
sudo journalctl -u maction-api.service -f
sudo journalctl -u maction-portal.service -f

# Restart after deployment
sudo systemctl restart maction-api.service
sudo systemctl restart maction-portal.service

# Stop services
sudo systemctl stop maction-portal.service
sudo systemctl stop maction-api.service
```

## Deployment Workflow

After a new build is deployed to `/opt/maction/`:

```bash
# 1. API server (no build step — Bun runs TypeScript directly)
sudo systemctl restart maction-api.service

# 2. Web portal (requires build)
cd /opt/maction/web-portal
sudo -u maction node_modules/.bin/nuxt build
sudo systemctl restart maction-portal.service
```

## Customization

- **Ports**: Update `PORT` environment in the unit file and match in Nginx upstream config
- **Memory limits**: Adjust `MemoryMax` based on server capacity
- **Deploy paths**: Update `WorkingDirectory` and `EnvironmentFile` if using a different layout
- **Bun path**: Update `ExecStart` path if Bun is installed elsewhere (check with `which bun`)
