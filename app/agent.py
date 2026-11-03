"""The production entry point: answer one member question with the policy_agent config."""

import asyncio
import os
import sys
from functools import lru_cache

from dotenv import load_dotenv
from launchdarkly_ai_openai_messages import create_openai_messages_handler
from launchdarkly_ai_server import ProviderHandler, config, init_client, shutdown

from .members import Member, get_member
from .tools import TOOL_HANDLERS

load_dotenv()
CONFIG_KEY = os.environ.get("LD_AI_CONFIG_KEY", "policy-agent")

@lru_cache(maxsize=1)
def handler() -> ProviderHandler:
    """The handler that serves production traffic. The evals call this too, so a
    run tests exactly the code path members hit.

    Built on first use because the OpenAI client reads OPENAI_API_KEY when it's created.
    """
    return create_openai_messages_handler()


async def answer(question: str, member: Member) -> str:
    result = await config(key=CONFIG_KEY, handler=handler(), tool_handlers=TOOL_HANDLERS).invoke(
        question, member.context(), variables={"member_id": member.member_id}
    )
    return result.response


async def main() -> None:
    if len(sys.argv) != 3:
        sys.exit('Usage: python -m app.agent <member_id> "<question>"')
    await init_client({"sdkKey": os.environ["LD_SDK_KEY"]})
    try:
        print(await answer(sys.argv[2], get_member(sys.argv[1])))
    finally:
        await shutdown()


if __name__ == "__main__":
    asyncio.run(main())
