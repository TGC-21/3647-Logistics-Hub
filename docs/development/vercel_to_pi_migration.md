PLEASE NOTE: The information below is irrelevant. At one point, the database was migrated to a pi, but we have decided to host the entirety of the application on an Oracle VM instance. Thank you. 



# Partshelf Vercel → Oracle VM Migration Summary
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

An Oracle VM instance is already an always-running server. Recreating a serverless platform on the VM adds unnecessary complexity.

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

the VM will run:

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
Home PC (LLM Inferencing)

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

Do not move PostgreSQL to the Oracle VM yet.

Final:

Oracle VM
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
> Home PC
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