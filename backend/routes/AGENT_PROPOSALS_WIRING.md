Add to backend/server.js, alongside the other route imports/mounts:

    import agentProposals from "./routes/agent-proposals.js";
    ...
    app.route("/api/agent-proposals", agentProposals);

Also run `random schemas/schema_harness_proposal_queue.sql` against your
Supabase project before deploying — it's additive (adds
harness_conversations.pending_proposals, default '[]'), safe on an
existing database.
