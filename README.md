# FlowDesk

TypeScript + Express backend with PostgreSQL.

## Run locally

```bash
npm install
cp .env.example .env     # then set DATABASE_URL and PORT
npm run dev              # http://localhost:3000/health
```

## Make the server live

### 1. Create a hosted PostgreSQL database
Use a managed provider (Neon, Supabase, Render Postgres, Railway, AWS RDS) and copy its connection string, e.g.
`postgresql://user:pass@host:5432/dbname`. Some providers require SSL; if so, append `?sslmode=require` to the URL.

### 2. Deploy the server (example: Render / Railway)
1. Push this repo to GitHub (`.env` is git-ignored, so secrets stay out).
2. Create a new **Web Service** from the repo.
3. Set the commands:
   - Build: `npm install && npm run build`
   - Start: `npm start`
4. Add environment variables in the dashboard:
   - `DATABASE_URL` = your hosted Postgres connection string
   - `PORT` is usually provided by the platform automatically
5. Deploy, then open `https://<your-app-url>/health`. It should return `{"status":"ok", ...}`.

### 3. Alternative: your own VPS
```bash
git clone <repo> && cd FlowDesk
npm install && npm run build
# set DATABASE_URL and PORT in the environment or a .env file
npm install -g pm2
pm2 start dist/server.js --name flowdesk
pm2 save && pm2 startup
```
Put Nginx (or Caddy) in front as a reverse proxy to `localhost:PORT` and enable HTTPS with Let's Encrypt.

## Scripts

| Command         | Purpose                       |
| --------------- | ----------------------------- |
| `npm run dev`   | Run with auto-reload          |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start`     | Run the compiled server       |
