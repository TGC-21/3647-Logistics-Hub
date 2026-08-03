# Partshelf Vercel → Raspberry Pi Migration Summary
## Current Architecture

Partshelf currently uses Vercel's hosting model:

> Browser
>    |
>    |
> Vercel
>    |
>    ├── Vite frontend
>    |
>    └── Serverless API Functions
>            |
>            Supabase PostgreSQL

The /api/*.js files are Vercel serverless functions. Vercel automatically turns files like:

> api/assembly-parts.js

into API endpoints:

POST /api/assembly-parts

> Vercel handles:

- starting the function runtime
- routing requests
- managing execution
- scaling
- shutting down idle functions

## Why Move Away From Vercel Serverless Functions?

A Raspberry Pi is already an always-running server. Recreating a serverless platform on the Pi adds unnecessary complexity.

Instead of:

> Request
>   ↓
> Vercel creates function
>   ↓
> Function runs
>   ↓
> Response
>   ↓
> Function removed

the Pi will run:

> Request
>   ↓
> Node backend already running
>   ↓
> Route executes
>   ↓
> Response

## Key Discovery: Partshelf Is Already Architected Well

Your current code separation is ideal for migration.

Your current flow:

> Vercel API Route
>         |
>         ↓
> AssemblyPartService
>         |
>         ├── AssemblyPartRepository
>         |
>         └── InventoryInstanceRepository
>                     |
>                     ↓
>               Supabase Client

The important logic is already outside the Vercel functions.

The migration is not a rewrite.

The main change is replacing:

> Vercel API wrapper

with:

> Node backend routes

## Target Architecture
User Browser
      |
      |
partshelf.com
      |
      |
Oracle Cloud VM
      |
      | Caddy HTTPS Reverse Proxy
      |
WireGuard Tunnel
      |
      |
Raspberry Pi
      |
      ├── Vite Frontend
      |
      └── Node API Backend
              |
              |
          Supabase PostgreSQL

## New Application Structure

Recommended structure:

partshelf/

frontend/
├── src/
├── public/
└── dist/

backend/
├── server.js
├── routes/
│   ├── assembly-parts.js
│   ├── categories.js
│   └── inventory.js
│
├── services/
│   └── AssemblyPartService.js
│
├── repositories/
│   ├── AssemblyPartRepository.js
│   └── InventoryInstanceRepository.js
│
└── lib/
    └── supabase.js

## Frontend Changes

Very little changes.

Your Vite app continues to:

> npm run build

which produces:

> dist/
> 
> index.html
> assets/

Caddy serves this as static files.

## Backend Changes

Your existing:

> api/assembly-parts.js

becomes something like:

> backend/routes/assembly-parts.js

The logic remains almost identical:

Before:

> export default async function handler(req,res)

After:

> router.post("/", async(req,res)=>{

The service layer stays:

> AssemblyPartService

The repositories stay:

> AssemblyPartRepository
> InventoryInstanceRepository

## Database Strategy

Keep Supabase.

Do not move PostgreSQL to the Pi yet.

Final:

Raspberry Pi
    |
    |
Node Backend
    |
    |
Supabase PostgreSQL

Benefits:

- managed backups
- easier recovery
- database survives Pi failure
- less maintenance

## Environment Variables

The current frontend likely uses:

VITE_SUPABASE_URL
VITE_SUPABASE_KEY

Those are browser-facing.

The backend should use:

SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY

The service role key stays only on the Pi.

Never expose it to the frontend.

## Recommended Technology Stack
Purpose	                Technology
----------------------------------------------
Frontend	            Vite + React
Backend API	            Node + Hono or Express
Database	            Supabase PostgreSQL
Reverse Proxy	        Caddy
Secure Tunnel	        WireGuard
Deployment	            Docker Compose

## Migration Steps
### Phase 1 — Extract Backend Locally

On your development machine:

1. Create:
> backend/

2. Move one API route:
> api/assembly-parts.js
to:
> backend/routes/assembly-parts.js

3. Create:
> backend/server.js

4. Run:

Frontend:

> localhost:5173

Backend:

> localhost:3000

Verify Partshelf works without Vercel.

### Phase 2 — Migrate Remaining API Routes

Convert:

> api/*.js

into:

> backend/routes/*.js

Keep:

services/
repositories/

unchanged.

### Phase 3 — Containerize

Create Docker services:

> docker-compose.yml
> 
> services:
> 
>   frontend:
>       Vite build served by Caddy
> 
>   backend:
>       Node API server

No database container is needed.

### Phase 4 — Deploy to Raspberry Pi

The Pi runs:

> Docker Compose
> 
> ├── Partshelf frontend
> └── Partshelf backend

The Oracle VM handles:

> HTTPS
> Domain routing
> Public exposure

The Pi remains private behind WireGuard.

## Final Result

The final system is:

> Internet
>    |
>    |
> Oracle VM
>    |
>    |
> Encrypted WireGuard tunnel
>    |
>    |
> Raspberry Pi
> 
> Caddy
>  |
>  ├── Vite frontend
>  |
>  └── Node API backend
>           |
>           |
>        Supabase

The migration is primarily a hosting model change, not an application rewrite. The existing service/repository architecture already provides the separation needed to move away from Vercel cleanly.