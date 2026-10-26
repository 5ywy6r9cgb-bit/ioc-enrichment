# Neo4j runbook (local only)

Install and start (Mac, Homebrew):

    brew install neo4j
    neo4j-admin dbms set-initial-password YOUR-PASSWORD   # type it yourself; never paste it in chat
    brew services start neo4j

Put the password in modules/connectors/.env (mode 600, gitignored):

    NEO4J_URI=bolt://localhost:7687
    NEO4J_USER=neo4j
    NEO4J_PASSWORD=...

Build and verify:

    cd modules/connectors && npm install neo4j-driver
    cd ~/sentinel && bin/sentinel connect graph --full         # preview, writes nothing
    bin/sentinel connect graph --full --push                   # writes, then reads back and reconciles

Browser: http://localhost:7474 . Tier is on the relationship type, not a property:
REPRESENTED_BY, RECEIVED_AWARD_FROM, REGISTERED_IN, PARTY_TO (one hop, each from a register),
SEARCH_RETURNED (a string in an index, Subject to Record only, never Org to Org).
Nodes are names (`identity: NAME_ONLY`) and are never merged. Money is `amount_text`, as printed, never summed.
