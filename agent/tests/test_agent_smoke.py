import importlib.util
from pathlib import Path


def test_agent_entrypoint_imports_without_credentials() -> None:
    agent_path = Path(__file__).parents[1] / "src" / "agent.py"
    spec = importlib.util.spec_from_file_location("sidekick_agent", agent_path)
    assert spec is not None
    assert spec.loader is not None

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert callable(module.entrypoint)
