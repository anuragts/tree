"""Tree coding agent for Agno AgentOS."""

import os
from pathlib import Path

from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.os import AgentOS
from agno.tools.coding import CodingTools


WORKSPACE = Path(os.getenv("TREE_WORKSPACE", os.getcwd())).resolve()
DB_FILE = Path(os.getenv("TREE_AGNO_DB", str(WORKSPACE / ".tree" / "agno-agentos.db"))).resolve()
HOST = os.getenv("TREE_AGNO_HOST", "localhost")
PORT = int(os.getenv("TREE_AGNO_PORT", "7867"))
MODEL = os.getenv("TREE_AGNO_MODEL", "openai:gpt-5.4")

DB_FILE.parent.mkdir(parents=True, exist_ok=True)

coding_agent = Agent(
    id="coding-agent",
    name="Tree Coding Agent",
    model=MODEL,
    tools=[
        CodingTools(
            base_dir=WORKSPACE,
            restrict_to_base_dir=True,
            all=True,
        )
    ],
    instructions=[
        "You are Tree's local coding agent running inside AgentOS.",
        "Work only inside the configured workspace.",
        "Inspect files before editing them.",
        "Make focused changes and verify them with relevant commands.",
        "Prefer concise explanations after changes.",
    ],
    add_history_to_context=True,
    num_history_runs=3,
    add_datetime_to_context=True,
    markdown=True,
)

agent_os = AgentOS(
    description="Tree AgentOS sidecar with a coding agent backed by CodingTools.",
    agents=[coding_agent],
    db=SqliteDb(db_file=str(DB_FILE)),
    tracing=True,
)
app = agent_os.get_app()


if __name__ == "__main__":
    agent_os.serve(app=app, host=HOST, port=PORT, reload=False, access_log=False)
