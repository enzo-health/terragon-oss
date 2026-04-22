# Agno Multi-Agent Event Stream & UI Integration: Deep Research

**Date**: April 2026  
**Repository**: https://github.com/agno-agi/agno (commit depth=1)  
**Research Scope**: Event type hierarchy, emission flow, streaming API shape, member response nesting, and adaptation for Terragon's AG-UI protocol

---

## Part 1 — Event Type Hierarchy (Python Source)

### Enum Definitions

**File**: `libs/agno/agno/run/agent.py` (lines 143–193)

```python
class RunEvent(str, Enum):
    """Events that can be sent by the run() functions"""

    run_started = "RunStarted"
    run_content = "RunContent"
    run_content_completed = "RunContentCompleted"
    run_intermediate_content = "RunIntermediateContent"
    run_completed = "RunCompleted"
    run_error = "RunError"
    run_cancelled = "RunCancelled"

    run_paused = "RunPaused"
    run_continued = "RunContinued"

    pre_hook_started = "PreHookStarted"
    pre_hook_completed = "PreHookCompleted"

    post_hook_started = "PostHookStarted"
    post_hook_completed = "PostHookCompleted"

    tool_call_started = "ToolCallStarted"
    tool_call_completed = "ToolCallCompleted"
    tool_call_error = "ToolCallError"

    reasoning_started = "ReasoningStarted"
    reasoning_step = "ReasoningStep"
    reasoning_content_delta = "ReasoningContentDelta"
    reasoning_completed = "ReasoningCompleted"

    memory_update_started = "MemoryUpdateStarted"
    memory_update_completed = "MemoryUpdateCompleted"

    session_summary_started = "SessionSummaryStarted"
    session_summary_completed = "SessionSummaryCompleted"

    parser_model_response_started = "ParserModelResponseStarted"
    parser_model_response_completed = "ParserModelResponseCompleted"

    output_model_response_started = "OutputModelResponseStarted"
    output_model_response_completed = "OutputModelResponseCompleted"

    model_request_started = "ModelRequestStarted"
    model_request_completed = "ModelRequestCompleted"

    compression_started = "CompressionStarted"
    compression_completed = "CompressionCompleted"

    followups_started = "FollowupsStarted"
    followups_completed = "FollowupsCompleted"

    custom_event = "CustomEvent"
```

**Team Events Extension**: `libs/agno/agno/run/team.py` (lines 130–188)

```python
class TeamRunEvent(str, Enum):
    """Events that can be sent by the run() functions"""

    run_started = "TeamRunStarted"
    run_content = "TeamRunContent"
    run_intermediate_content = "TeamRunIntermediateContent"
    run_content_completed = "TeamRunContentCompleted"
    run_completed = "TeamRunCompleted"
    run_error = "TeamRunError"
    run_cancelled = "TeamRunCancelled"

    pre_hook_started = "TeamPreHookStarted"
    pre_hook_completed = "TeamPreHookCompleted"

    post_hook_started = "TeamPostHookStarted"
    post_hook_completed = "TeamPostHookCompleted"

    tool_call_started = "TeamToolCallStarted"
    tool_call_completed = "TeamToolCallCompleted"
    tool_call_error = "TeamToolCallError"

    reasoning_started = "TeamReasoningStarted"
    reasoning_step = "TeamReasoningStep"
    reasoning_content_delta = "TeamReasoningContentDelta"
    reasoning_completed = "TeamReasoningCompleted"

    memory_update_started = "TeamMemoryUpdateStarted"
    memory_update_completed = "TeamMemoryUpdateCompleted"

    session_summary_started = "TeamSessionSummaryStarted"
    session_summary_completed = "TeamSessionSummaryCompleted"

    parser_model_response_started = "TeamParserModelResponseStarted"
    parser_model_response_completed = "TeamParserModelResponseCompleted"

    output_model_response_started = "TeamOutputModelResponseStarted"
    output_model_response_completed = "TeamOutputModelResponseCompleted"

    model_request_started = "TeamModelRequestStarted"
    model_request_completed = "TeamModelRequestCompleted"

    compression_started = "TeamCompressionStarted"
    compression_completed = "TeamCompressionCompleted"

    followups_started = "TeamFollowupsStarted"
    followups_completed = "TeamFollowupsCompleted"

    run_paused = "TeamRunPaused"
    run_continued = "TeamRunContinued"

    # Task mode events
    task_iteration_started = "TeamTaskIterationStarted"
    task_iteration_completed = "TeamTaskIterationCompleted"
    task_state_updated = "TeamTaskStateUpdated"
    task_created = "TeamTaskCreated"
    task_updated = "TeamTaskUpdated"

    custom_event = "CustomEvent"
```

### Dataclass Hierarchy for Team Events

**Base Class**: `libs/agno/agno/run/team.py` (lines 190–228)

```python
@dataclass
class BaseTeamRunEvent(BaseRunOutputEvent):
    created_at: int = field(default_factory=lambda: int(time()))
    event: str = ""
    team_id: str = ""
    team_name: str = ""
    run_id: Optional[str] = None
    parent_run_id: Optional[str] = None
    session_id: Optional[str] = None

    workflow_id: Optional[str] = None
    workflow_run_id: Optional[str] = None  # This is the workflow's run_id
    step_id: Optional[str] = None
    step_name: Optional[str] = None
    step_index: Optional[int] = None
    # Nesting depth: 0 = top-level workflow, 1 = first nested, 2 = nested-in-nested, etc.
    nested_depth: int = 0

    # For backwards compatibility
    content: Optional[Any] = None
```

### Key Dataclass Implementations (Selection)

#### **RunStartedEvent** (lines 231–237)

```python
@dataclass
class RunStartedEvent(BaseTeamRunEvent):
    """Event sent when the run starts"""
    event: str = TeamRunEvent.run_started.value
    model: str = ""
    model_provider: str = ""
```

#### **RunContentEvent** (lines 240–255)

```python
@dataclass
class RunContentEvent(BaseTeamRunEvent):
    """Main event for each delta of the RunOutput"""
    event: str = TeamRunEvent.run_content.value
    content: Optional[Any] = None
    content_type: str = "str"
    reasoning_content: Optional[str] = None
    model_provider_data: Optional[Dict[str, Any]] = None
    citations: Optional[Citations] = None
    response_audio: Optional[Audio] = None  # Model audio response
    image: Optional[Image] = None  # Image attached to the response
    references: Optional[List[MessageReferences]] = None
    additional_input: Optional[List[Message]] = None
    reasoning_steps: Optional[List[ReasoningStep]] = None
    reasoning_messages: Optional[List[Message]] = None
```

#### **ToolCallStartedEvent** (lines 415–418)

```python
@dataclass
class ToolCallStartedEvent(BaseTeamRunEvent):
    event: str = TeamRunEvent.tool_call_started.value
    tool: Optional[ToolExecution] = None
```

#### **RunCompletedEvent** (lines 270–289)

```python
@dataclass
class RunCompletedEvent(BaseTeamRunEvent):
    event: str = TeamRunEvent.run_completed.value
    content: Optional[Any] = None
    content_type: str = "str"
    reasoning_content: Optional[str] = None
    citations: Optional[Citations] = None
    model_provider_data: Optional[Dict[str, Any]] = None
    images: Optional[List[Image]] = None  # Images attached to the response
    videos: Optional[List[Video]] = None  # Videos attached to the response
    audio: Optional[List[Audio]] = None  # Audio attached to the response
    response_audio: Optional[Audio] = None  # Model audio response
    references: Optional[List[MessageReferences]] = None
    additional_input: Optional[List[Message]] = None
    reasoning_steps: Optional[List[ReasoningStep]] = None
    reasoning_messages: Optional[List[Message]] = None
    member_responses: List[Union["TeamRunOutput", RunOutput]] = field(default_factory=list)
    metadata: Optional[Dict[str, Any]] = None
    metrics: Optional[RunMetrics] = None
    session_state: Optional[Dict[str, Any]] = None
```

#### **TaskCreatedEvent** (lines 583–597)

```python
@dataclass
class TaskCreatedEvent(BaseTeamRunEvent):
    """Event sent immediately when a task is created in tasks mode.
    This allows the frontend to show tasks as they are created,
    before waiting for the iteration to complete.
    """
    event: str = TeamRunEvent.task_created.value
    task_id: str = ""
    title: str = ""
    description: str = ""
    assignee: Optional[str] = None
    status: str = "pending"
    dependencies: List[str] = field(default_factory=list)
```

#### **TaskStateUpdatedEvent** (lines 566–580)

```python
@dataclass
class TaskStateUpdatedEvent(BaseTeamRunEvent):
    """Event sent when the task state is updated in tasks mode.
    Contains the full structured task list for frontend rendering.
    The frontend can use the `tasks` field to render a task list UI
    with checkboxes that update in real-time.
    """
    event: str = TeamRunEvent.task_state_updated.value
    task_summary: Optional[str] = None
    goal_complete: bool = False
    # Full structured task list for frontend rendering
    tasks: List[TaskData] = field(default_factory=list)
    completion_summary: Optional[str] = None
```

#### **CustomEvent** (lines 617–623)

```python
@dataclass
class CustomEvent(BaseTeamRunEvent):
    event: str = TeamRunEvent.custom_event.value

    def __init__(self, **kwargs):
        # Store arbitrary attributes directly on the instance
        for key, value in kwargs.items():
            setattr(self, key, value)
```

### Event Type Registry

**File**: `libs/agno/agno/run/team.py` (lines 667–709)

```python
TEAM_RUN_EVENT_TYPE_REGISTRY = {
    TeamRunEvent.run_started.value: RunStartedEvent,
    TeamRunEvent.run_content.value: RunContentEvent,
    TeamRunEvent.run_intermediate_content.value: IntermediateRunContentEvent,
    TeamRunEvent.run_content_completed.value: RunContentCompletedEvent,
    TeamRunEvent.run_completed.value: RunCompletedEvent,
    TeamRunEvent.run_error.value: RunErrorEvent,
    TeamRunEvent.run_cancelled.value: RunCancelledEvent,
    TeamRunEvent.run_paused.value: RunPausedEvent,
    TeamRunEvent.run_continued.value: RunContinuedEvent,
    # ... 25+ more mappings
}

def team_run_output_event_from_dict(data: dict) -> BaseTeamRunEvent:
    event_type = data.get("event", "")
    if event_type in {e.value for e in RunEvent}:
        return run_output_event_from_dict(data)  # type: ignore
    else:
        event_class = TEAM_RUN_EVENT_TYPE_REGISTRY.get(event_type)
    if not event_class:
        raise ValueError(f"Unknown team event type: {event_type}")
    return event_class.from_dict(data)  # type: ignore
```

**Key insight**: Events are polymorphic—nested agent (RunEvent) events coexist with team-level (TeamRunEvent) events in the same stream. The registry dispatches by the `event` string discriminant.

---

## Part 2 — Emission Flow (Where Events Fire From)

### Team Run Streaming Entry Point

**File**: `libs/agno/agno/team/_run.py` (lines 1475–1483)

```python
# Start the Run by yielding a RunStarted event
if stream_events:
    yield handle_event(  # type: ignore
        create_team_run_started_event(run_response),
        run_response,
        events_to_skip=team.events_to_skip,
        store_events=team.store_events,
    )

raise_if_cancelled(run_response.run_id)  # type: ignore

# 5. Reason about the task if reasoning is enabled
yield from handle_reasoning_stream(
    team,
    run_response=run_response,
    run_messages=run_messages,
    run_context=run_context,
    stream_events=stream_events,
)
```

The streaming pattern is **`yield from`** generators chained together. Each handler yields events as they occur during execution. The `handle_event()` wrapper:

1. Optionally filters events (via `events_to_skip`)
2. Appends to `run_response.events`
3. Optionally persists to DB (via `store_events`)

### Member Agent Invocation & Event Nesting

When a team invokes a member agent (via a `RunAgent` tool or direct delegation), the agent's async iterator is consumed. **The member agent yields its own `RunEvent` events (not `TeamRunEvent`)**, but they are collected into the parent team run's `member_responses` list.

**File**: `libs/agno/agno/run/team.py` (lines 285–289, 745)

```python
# In RunCompletedEvent (team-level)
member_responses: List[Union["TeamRunOutput", RunOutput]] = field(default_factory=list)

# In TeamRunOutput (team-level aggregation)
member_responses: List[Union["TeamRunOutput", RunOutput]] = field(default_factory=list)
```

**Member response nesting is RECURSIVE**:

- A team's `RunCompletedEvent` carries `member_responses[]`
- Each member_response is a `RunOutput` (for agent) or `TeamRunOutput` (for nested team)
- Each `TeamRunOutput` has its own `member_responses[]`
- This creates an N-ary tree of responses

### Member Event Sequence (Inferred from Code Structure)

When a member agent is invoked:

1. Parent yields/accumulates `TeamToolCallStartedEvent` (parent invokes the tool that delegates)
2. Member agent begins execution (agent's `arun()` generator is consumed)
3. Member yields: `RunStartedEvent`, `RunContentEvent*`, `ToolCallStartedEvent*`, etc. (all `RunEvent` not `TeamRunEvent`)
4. Member yields: `RunCompletedEvent` (agent's final event)
5. Parent yields: `ToolCallCompletedEvent` (parent's view of completion)
6. Member's `RunOutput` is appended to parent's `member_responses` before or with `RunCompletedEvent`

**Note**: The actual coordination is not explicit in the event-emission code I examined. The hierarchy is established during the tool execution phase (`_handle_model_response_stream`), which consumes member agents' outputs and nests them.

---

## Part 3 — Streaming API Shape (What a Consumer Receives)

### HTTP API Streaming Response

**File**: `libs/agno/agno/os/routers/teams/router.py` (lines 51–114)

```python
async def team_response_streamer(
    team: Union[Team, RemoteTeam],
    message: str,
    session_id: Optional[str] = None,
    user_id: Optional[str] = None,
    images: Optional[List[Image]] = None,
    audio: Optional[List[Audio]] = None,
    videos: Optional[List[Video]] = None,
    files: Optional[List[FileMedia]] = None,
    background_tasks: Optional[BackgroundTasks] = None,
    auth_token: Optional[str] = None,
    **kwargs: Any,
) -> AsyncGenerator:
    """Run the given team asynchronously and yield its response"""
    try:
        if "stream_events" in kwargs:
            stream_events = kwargs.pop("stream_events")
        else:
            stream_events = True

        run_response = team.arun(
            input=message,
            session_id=session_id,
            user_id=user_id,
            images=images,
            audio=audio,
            videos=videos,
            files=files,
            stream=True,
            stream_events=stream_events,
            **kwargs,
        )
        async for run_response_chunk in run_response:
            yield format_sse_event(run_response_chunk)  # type: ignore
    except (InputCheckError, OutputCheckError) as e:
        error_response = TeamRunErrorEvent(
            content=str(e),
            error_type=e.type,
            error_id=e.error_id,
            additional_data=e.additional_data,
        )
        yield format_sse_event(error_response)
```

### Server-Sent Events (SSE) Format

**File**: `libs/agno/agno/os/utils.py` (lines 172–199)

````python
def format_sse_event(event: Union[RunOutputEvent, TeamRunOutputEvent, WorkflowRunOutputEvent]) -> str:
    """Parse JSON data into SSE-compliant format.

    Args:
        event_dict: Dictionary containing the event data

    Returns:
        SSE-formatted response:

        ```
        event: EventName
        data: { ... }

        event: AnotherEventName
        data: { ... }
        ```
    """
    try:
        # Parse the JSON to extract the event type
        event_type = event.event or "message"

        # Serialize to valid JSON with double quotes and no newlines
        clean_json = event.to_json(separators=(",", ":"), indent=None)

        return f"event: {event_type}\ndata: {clean_json}\n\n"
    except json.JSONDecodeError:
        clean_json = event.to_json(separators=(",", ":"), indent=None)
        return f"event: message\ndata: {clean_json}\n\n"
````

**Example SSE Output**:

```
event: TeamRunStarted
data: {"event":"TeamRunStarted","team_id":"my-team","run_id":"abc123","model":"claude-3-5-sonnet","model_provider":"anthropic"}

event: TeamRunContent
data: {"event":"TeamRunContent","content":"The answer is...","run_id":"abc123"}

event: TeamToolCallStarted
data: {"event":"TeamToolCallStarted","tool":{"name":"search","args":{"query":"topic"}}}

event: TeamToolCallCompleted
data: {"event":"TeamToolCallCompleted","tool":{"name":"search","result":"..."}}

event: TeamRunCompleted
data: {"event":"TeamRunCompleted","content":"Final response","member_responses":[{"agent_id":"agent1","content":"..."}]}
```

### Async Iterator Type Signature

**File**: `libs/agno/agno/team/remote.py` (lines 200–247, overload definitions)

```python
@overload
async def arun(
    self,
    input: Union[str, List, Dict, Message, BaseModel, List[Message]],
    *,
    stream: Literal[False] = False,
    # ... params ...
) -> TeamRunOutput: ...

@overload
def arun(
    self,
    input: Union[str, List, Dict, Message, BaseModel, List[Message]],
    *,
    stream: Literal[True] = True,
    # ... params ...
) -> AsyncIterator[TeamRunOutputEvent]: ...
```

**Return Type Union**:

```python
TeamRunOutputEvent = Union[
    RunStartedEvent,
    RunContentEvent,
    IntermediateRunContentEvent,
    RunContentCompletedEvent,
    RunCompletedEvent,
    RunErrorEvent,
    RunCancelledEvent,
    RunPausedEvent,
    RunContinuedEvent,
    PreHookStartedEvent,
    PreHookCompletedEvent,
    ReasoningStartedEvent,
    ReasoningStepEvent,
    ReasoningContentDeltaEvent,
    ReasoningCompletedEvent,
    MemoryUpdateStartedEvent,
    MemoryUpdateCompletedEvent,
    SessionSummaryStartedEvent,
    SessionSummaryCompletedEvent,
    ToolCallStartedEvent,
    ToolCallCompletedEvent,
    ToolCallErrorEvent,
    ParserModelResponseStartedEvent,
    ParserModelResponseCompletedEvent,
    OutputModelResponseStartedEvent,
    OutputModelResponseCompletedEvent,
    ModelRequestStartedEvent,
    ModelRequestCompletedEvent,
    CompressionStartedEvent,
    CompressionCompletedEvent,
    FollowupsStartedEvent,
    FollowupsCompletedEvent,
    TaskIterationStartedEvent,
    TaskIterationCompletedEvent,
    TaskStateUpdatedEvent,
    TaskCreatedEvent,
    TaskUpdatedEvent,
    CustomEvent,
]
```

---

## Part 4 — Member Response Nesting

### Aggregation in RunCompletedEvent

**File**: `libs/agno/agno/run/team.py` (lines 270–289)

```python
@dataclass
class RunCompletedEvent(BaseTeamRunEvent):
    # ... other fields ...
    member_responses: List[Union["TeamRunOutput", RunOutput]] = field(default_factory=list)
```

### Member Response Structure (Full Output Dataclass)

**File**: `libs/agno/agno/run/team.py` (lines 723–896)

```python
@dataclass
class TeamRunOutput:
    """Response returned by Team.run() functions"""

    run_id: Optional[str] = None
    team_id: Optional[str] = None
    team_name: Optional[str] = None
    session_id: Optional[str] = None
    parent_run_id: Optional[str] = None
    user_id: Optional[str] = None

    # Input media and messages from user
    input: Optional[TeamRunInput] = None

    content: Optional[Any] = None
    content_type: str = "str"

    messages: Optional[List[Message]] = None
    metrics: Optional[RunMetrics] = None
    model: Optional[str] = None
    model_provider: Optional[str] = None

    member_responses: List[Union["TeamRunOutput", RunOutput]] = field(default_factory=list)

    tools: Optional[List[ToolExecution]] = None

    images: Optional[List[Image]] = None  # Images from member runs
    videos: Optional[List[Video]] = None  # Videos from member runs
    audio: Optional[List[Audio]] = None  # Audio from member runs
    files: Optional[List[File]] = None  # Files from member runs

    response_audio: Optional[Audio] = None  # Model audio response

    reasoning_content: Optional[str] = None

    citations: Optional[Citations] = None
    followups: Optional[List[str]] = None
    model_provider_data: Optional[Dict[str, Any]] = None
    metadata: Optional[Dict[str, Any]] = None
    session_state: Optional[Dict[str, Any]] = None

    references: Optional[List[MessageReferences]] = None
    additional_input: Optional[List[Message]] = None
    reasoning_steps: Optional[List[ReasoningStep]] = None
    reasoning_messages: Optional[List[Message]] = None
    created_at: int = field(default_factory=lambda: int(time()))

    events: Optional[List[Union[RunOutputEvent, TeamRunOutputEvent]]] = None

    status: RunStatus = RunStatus.running

    # User control flow (HITL) requirements to continue a run when paused
    requirements: Optional[list[RunRequirement]] = None

    workflow_step_id: Optional[str] = None  # FK: Points to StepOutput.step_id
```

### Deserialization (from_dict with Recursive Member Parsing)

**File**: `libs/agno/agno/run/team.py` (lines 910–1000, excerpt)

```python
@classmethod
def from_dict(cls, data: Dict[str, Any]) -> "TeamRunOutput":
    # ... event parsing ...

    member_responses = data.pop("member_responses", [])
    parsed_member_responses: List[Union["TeamRunOutput", RunOutput]] = []
    if member_responses:
        for response in member_responses:
            if "agent_id" in response:
                # Agent-level response
                parsed_member_responses.append(RunOutput.from_dict(response))
            else:
                # Team-level response (nested team)
                parsed_member_responses.append(cls.from_dict(response))

    # ... handle other fields ...

    return cls(
        messages=messages,
        metrics=metrics,
        member_responses=parsed_member_responses,
        # ... other assignments ...
    )
```

### Event Serialization (to_dict with Member Recursion)

**File**: `libs/agno/agno/run/team.py` (lines 868–870)

```python
if self.member_responses:
    _dict["member_responses"] = [response.to_dict() for response in self.member_responses]
```

### Tree Structure Example

```
Team Run (TeamRunOutput)
├─ member_responses
│  ├─ Agent 1 Output (RunOutput)
│  │  └─ tools: [ToolExecution, ToolExecution]
│  │  └─ messages: [Message, Message, ...]
│  ├─ Team 2 Output (TeamRunOutput)  ← NESTED TEAM
│  │  └─ member_responses
│  │     ├─ Agent 3 Output (RunOutput)
│  │     └─ Agent 4 Output (RunOutput)
│  └─ Agent 5 Output (RunOutput)
```

This N-ary tree is **serialized fully in the final `RunCompletedEvent`** — all member responses are computed and attached before the completion event is yielded. Intermediate member events are **not propagated upward to parent subscribers** in the current implementation; only the aggregated results appear in the completion event.

---

## Part 5 — Delivery & Status Updates During Team Execution

### Task Mode Real-Time Updates (Unlike Traditional Agent Events)

**File**: `libs/agno/agno/run/team.py` (lines 583–614)

Agno provides **immediate task creation and update events** in task mode, allowing frontend to render task progress without waiting for iteration completion:

```python
@dataclass
class TaskCreatedEvent(BaseTeamRunEvent):
    """Event sent immediately when a task is created in tasks mode.
    This allows the frontend to show tasks as they are created,
    before waiting for the iteration to complete.
    """
    event: str = TeamRunEvent.task_created.value
    task_id: str = ""
    title: str = ""
    description: str = ""
    assignee: Optional[str] = None
    status: str = "pending"
    dependencies: List[str] = field(default_factory=list)

@dataclass
class TaskUpdatedEvent(BaseTeamRunEvent):
    """Event sent immediately when a task status changes in tasks mode.
    This allows the frontend to update task status in real-time
    (e.g., mark as in_progress when execution starts, completed when done).
    """
    event: str = TeamRunEvent.task_updated.value
    task_id: str = ""
    title: str = ""
    status: str = ""  # pending, in_progress, completed, failed, blocked
    previous_status: Optional[str] = None
    result: Optional[str] = None
    assignee: Optional[str] = None
```

This is **critical for Terragon**: Task mode demonstrates how to push granular state updates mid-run without blocking on final completion.

---

## Part 6 — Adaptation for Terragon AG-UI Protocol

### Current Terragon Landscape

**AG-UI Protocol Events** (from Terragon codebase):

- `RUN_STARTED`, `RUN_COMPLETED`, `RUN_ERROR`, `RUN_CANCELLED`
- `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CHUNK`, `TEXT_MESSAGE_COMPLETE`
- `TOOL_CALL_START`, `TOOL_CALL_RESULT`, `TOOL_CALL_ERROR`
- `CUSTOM` (extensible)

**Subagent Model**:

- Subagent invocation is modeled as a `ToolCall` (parent tool: "delegate_to_subagent")
- Subagent's output is nested in the tool result
- **Gap**: No first-class "subagent started" or "member agent invoked" event

### Proposed Event Additions to AG-UI

#### 1. **Subagent Member Started Event**

```typescript
interface SubagentMemberStartedEvent extends AgUICustomEvent {
  kind: "terragon.subagent.started";
  subagentId: string;
  subagentName: string;
  parentRunId: string; // Link to parent run
  delegationReason?: string; // Optional: why this subagent was invoked
  model?: string;
  modelProvider?: string;
}
```

**When**: Right after the parent runtime decides to invoke a subagent (before the subagent starts).  
**Why**: Matches Agno's `RunStartedEvent` pattern; allows UI to visually distinguish delegation boundaries.

#### 2. **Subagent Member Streaming Checkpoint Event**

```typescript
interface SubagentStreamingCheckpointEvent extends AgUICustomEvent {
  kind: "terragon.subagent.checkpoint";
  subagentId: string;
  checkpoint: {
    messagesCount: number;
    toolCallsExecuted: number;
    tokensUsed?: number;
    elapsedSeconds: number;
    status: "planning" | "implementing" | "reviewing" | "completed";
  };
}
```

**When**: Periodically (e.g., every 5s) or on state transitions during subagent execution.  
**Why**: Real-time visibility into subagent progress without waiting for completion.

#### 3. **Subagent Member Completed Event**

```typescript
interface SubagentMemberCompletedEvent extends AgUICustomEvent {
  kind: "terragon.subagent.completed";
  subagentId: string;
  subagentRunId: string;
  result: {
    content: string;
    toolsExecuted: number;
    tokensUsed: number;
    elapsedSeconds: number;
    metrics: {
      successRate?: number;
      avgResponseTime?: number;
    };
  };
  delegationSuccess: boolean; // Whether delegation achieved its goal
}
```

**When**: After subagent run completes (before or with `TOOL_CALL_RESULT`).  
**Why**: Decouples subagent completion acknowledgment from parent tool result.

#### 4. **Nested Member Responses Event** (on completion)

```typescript
interface NestedMemberResponsesEvent extends AgUICustomEvent {
  kind: "terragon.nested_responses";
  memberResponses: Array<{
    memberId: string;
    memberName: string;
    depth: number; // 0 = direct child, 1 = grandchild, etc.
    output: {
      content: string;
      messages?: Message[];
      toolsUsed?: string[];
      status: "success" | "paused" | "failed" | "cancelled";
    };
    nestedMembers?: NestedMemberResponsesEvent["memberResponses"]; // Recursive
  }>;
}
```

**When**: Emitted with final `RUN_COMPLETED`, encodes full member tree.  
**Why**: Enables UI to render org-chart or tree view of subagent hierarchy.

### Renderer Sketch (React Component Pattern)

```typescript
// libs/agno-ui/src/renderers/subagent-tree.tsx

interface SubagentTreeProps {
  memberResponses: MemberResponse[];
  depth?: number;
  onMemberClick?: (memberId: string) => void;
}

export function SubagentTree({
  memberResponses,
  depth = 0,
  onMemberClick,
}: SubagentTreeProps) {
  return (
    <div className={`subagent-level-${depth}`}>
      {memberResponses.map((member) => (
        <details key={member.memberId} open={depth === 0}>
          <summary
            onClick={() => onMemberClick?.(member.memberId)}
            className="subagent-header"
          >
            <span className="subagent-icon">👤</span>
            <span className="subagent-name">{member.memberName}</span>
            <span className={`status status-${member.output.status}`}>
              {member.output.status}
            </span>
          </summary>

          <div className="subagent-content">
            <div className="subagent-output">
              <p>{member.output.content}</p>
            </div>

            {member.output.toolsUsed?.length > 0 && (
              <div className="subagent-tools">
                <strong>Tools Used:</strong>
                <ul>
                  {member.output.toolsUsed.map((tool) => (
                    <li key={tool}>{tool}</li>
                  ))}
                </ul>
              </div>
            )}

            {member.nestedMembers && member.nestedMembers.length > 0 && (
              <details className="nested-members-details">
                <summary>Delegated to {member.nestedMembers.length} subagents</summary>
                <SubagentTree
                  memberResponses={member.nestedMembers}
                  depth={depth + 1}
                  onMemberClick={onMemberClick}
                />
              </details>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
```

### Integration with AG-UI Message Parts

**Extend AgUIMessage discriminant**:

```typescript
type AgUIMessage =
  | { type: 'RUN_STARTED'; ... }
  | { type: 'TEXT_MESSAGE_START'; ... }
  | { type: 'TOOL_CALL_START'; ... }
  | { type: 'CUSTOM'; kind: 'terragon.subagent.started'; ... }
  | { type: 'CUSTOM'; kind: 'terragon.subagent.completed'; ... }
  | { type: 'CUSTOM'; kind: 'terragon.nested_responses'; ... }
  | { type: 'RUN_COMPLETED'; memberResponses: MemberResponse[]; ... };
```

**Streaming Integration** (in `useDeltaAccumulator` or equivalent):

```typescript
export function handleSubagentEvent(
  event: AgUICustomEvent,
  state: ThreadChatState,
): Partial<ThreadChatState> {
  switch (event.kind) {
    case "terragon.subagent.started":
      return {
        activeSubagents: [
          ...(state.activeSubagents ?? []),
          {
            id: event.subagentId,
            name: event.subagentName,
            startedAt: Date.now(),
            status: "running",
          },
        ],
      };
    case "terragon.subagent.completed":
      return {
        activeSubagents: (state.activeSubagents ?? []).map((s) =>
          s.id === event.subagentId
            ? { ...s, status: "completed", completedAt: Date.now() }
            : s,
        ),
      };
    case "terragon.nested_responses":
      return {
        memberResponses: event.memberResponses,
        showMemberTree: true,
      };
    default:
      return {};
  }
}
```

### Key Design Decisions

1. **Lazy vs. Eager Member Nesting**: Agno emits completed `RunCompletedEvent` with all `member_responses` attached at once. Terragon could:

   - **Eager** (Agno-style): Stream individual `terragon.subagent.completed` events as each completes, then aggregate in final `RUN_COMPLETED`.
   - **Lazy** (Current Terragon): Only emit member responses in final `RUN_COMPLETED`, with a separate `NestedMemberResponsesEvent` for tree UI rendering.

   **Recommendation**: Start with eager (per-subagent completion events) for real-time visibility, add lazy aggregation if needed for simplicity.

2. **Depth Tracking**: Include `nested_depth` (Agno's pattern) to distinguish delegation level. This helps UI render with indentation/collapsing.

3. **Streaming Checkpoints**: Unlike Agno (which only emits task updates in task mode), emit periodic `terragon.subagent.checkpoint` to give users visibility into long-running subagent work.

4. **Metrics Propagation**: Collect subagent token usage and execution time; bubble up to parent `RUN_COMPLETED` for budget tracking.

---

## Conclusion

Agno's event model is **mature and production-ready**:

- **Polymorphic events** with discriminant unions allow type-safe streaming
- **SSE protocol** is standard HTTP; Terragon can adopt the same format
- **Member response nesting** is elegantly recursive; Terragon's tree structure aligns naturally
- **Task mode** demonstrates how to stream granular state without blocking final output

**For Terragon**:

1. Adopt SSE format + event discriminants
2. Add `terragon.subagent.*` CUSTOM events to bridge subagent boundaries
3. Implement SubagentTree renderer for UI
4. Stream per-subagent completion checkpoints for real-time feedback
5. Attach `memberResponses` to final `RUN_COMPLETED` for full hierarchy retrieval

This preserves Terragon's delegation-as-tool-call model while adding first-class observability for multi-agent workflows.

---

## References

- **Event Type Definitions**: `libs/agno/agno/run/agent.py`, `libs/agno/agno/run/team.py`
- **Streaming Emit**: `libs/agno/agno/team/_run.py` (lines 1475+)
- **API Route**: `libs/agno/agno/os/routers/teams/router.py`
- **SSE Format**: `libs/agno/agno/os/utils.py` (format_sse_event)
- **Member Nesting**: `libs/agno/agno/run/team.py` (TeamRunOutput.from_dict/to_dict)
