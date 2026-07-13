# The five layers of agent specialization

A capable model in a fresh session is not a specialist. A specialist has
identity, habits, memory, teammates, and work to track. OAS names those needs
as five layers.

Two layers are the OAS pattern itself: **soul** and **instances**. The kernel
implements them directly. The other three are formally defined, exclusive
contracts: **knowledge**, **messaging**, and **tasks**. An integration is the
capability package selected to bind one contract to a real tool; general
capability packages remain additive.

## The layers at a glance

| Layer | Question it answers | Owner |
|---|---|---|
| **Soul** | Who is this agent, and how does it grow? | Kernel |
| **Knowledge** | Where does learning live, and how is it promoted? | Integration |
| **Instances** | How does a soul run work in the world? | Kernel |
| **Messaging** | How can this instance be reached by the team? | Integration |
| **Tasks** | Where does shared work state live? | Integration |

## 1. Soul — durable expert identity

A soul is what an agent *is* when no session is running. It contains the
agent's operating doc (`AGENTS.md`), its own skills, and any long-term
knowledge its knowledge layer provides.

A soul is committed and reviewed like code. It has no terminal, no network
identity, and no current task. It is the expert template that compounds over
many incarnations.

The kernel owns this layer. The shape of a soul is the pattern itself:
`soul.yaml`, canonical files, symlinks, and directory layout. Deployment
capabilities compose into instances and never redefine or mutate the soul.

## 2. Knowledge — learning that survives sessions

Specialization requires memory. The knowledge layer decides where memory
lives, what kinds exist, and how learning moves from an instance into the
soul.

The kernel is memory-agnostic. It only provides lifecycle events such as
`soul-scaffold`, `spawn`, and `retire`. A knowledge integration
uses those events to create memory files, teach the protocol, and run
promotion.

The default `oas-okf` integration creates an OKF bundle in the soul and
`STATE.md`, `log.md`, and `notes/` in instances. Instances capture what they
learn, and after committing with pending notes run `oas okf harvest`, which
spawns a memory-harvest agent that judges notes and promotes
what belongs in the soul.

If config resolves `knowledge: none`, none of this exists. The agent works
with whatever memory its harness or repo already provides.

See [Knowledge](knowledge.md).

## 3. Instances — the soul doing work

An instance is one running incarnation of a soul. It has a home directory, a
work tree, a task briefing, metadata, and possibly episodic memory.

Instances are disposable by design. Sessions crash, context windows fill, and
models change. The soul survives. With a knowledge integration, what matters
feeds back into the soul as the instance works.

The kernel owns this layer: spawn, exact skill/instruction composition,
resume, retire, work modes, tmux windows, metadata, and lifecycle hook points.

See [Souls and instances](souls-and-instances.md).

## 4. Messaging — reachable team identities

Team agents need to reach humans and each other. The messaging layer maps an
instance name to a communication identity, then cleans that identity up when
the instance retires.

The default integration is `oas-aweb`. It gives each instance an aweb identity
and teaches agents to use `aw mail` and `aw chat`.

Messaging is deliberately narrow. It is about communication only. Task
coordination belongs to layer 5.

## 5. Tasks — shared work state

Work needs a queue and status that outlive any one instance: planned, in
flight, blocked, done. OAS does not choose the tracker. It only requires that
agents know where the shared work state lives and how to use it.

There is no shipped default task integration. One deployment can bind Jira,
another Linear, another GitHub Issues. The LFX-style Jira integration is just
skills plus an injection that points agents at those skills.

## Why the split matters

Souls and instances are the stable core. Moving them out would leave nothing
to specialize.

Knowledge, messaging, and tasks vary by team. They should be easy to swap.
One workspace can run OKF + aweb + Jira. Another can run a team wiki + Slack
+ Linear. A repo can disable messaging with `messaging: none`. The soul stays
the same kind of object. Only its layer bindings change.

Layer exclusivity prevents two task systems or knowledge protocols from
competing inside one soul context. Capability targeting still allows another
soul to select a different provider. See [Integrations](integrations.md) and
[Capability packages](capabilities.md).
