# pi-world user guide

pi-world lets you build small applications by talking to an agent. You describe what you want; the agent writes the
code into a **world**; you, other programs and other worlds then use what it built, without the agent.

Every change the agent makes is tried first and kept only if it works. A change that fails leaves the world exactly as
it was, and every kept change can be undone.

## Ideas you need

| Idea | What it is |
|---|---|
| **World** | One application: its functions, its stored data and its web page. You can have many worlds on one server. |
| **Agent** | Claude, working inside one world. It adds and changes the world's functions when you ask it to. You need it only to change the world, never to use it. |
| **Function** | Something the world can do, such as `addTodo` or `convert`. Each has a short description and can be called by you, by a program or by another world. |
| **Revision** | A numbered, kept version of the world. Each change the agent makes successfully is a new revision. Going back to an earlier one is also a new revision, so nothing is lost. |
| **Rejected change** | A change the world turned away, because it failed, broke a check or ran too long. It is kept with its reason, and the world does not change. |
| **Check** | A rule every future change must keep true, such as "a deleted todo is never listed". The agent can propose one; only you can remove one, and you must give a reason. |
| **Data** | What the world stores while it is used: the todos, the expenses, the scores. Changing the world's functions keeps its data. |
| **App page** | A web page the world serves, if you ask the agent for one. |
| **Incident** | A call to a function that failed. It is kept with its arguments and error so it can be fixed and tried again. |
| **Access** | Which other worlds this world's functions may call: any, or only the ones you choose. Only you set it. |

## Getting started

Open `http://oracle-arm.mist-walleye.ts.net:8787` from a machine on the tailnet.

1. **Connect Claude.** Use **Connect Claude** in the sidebar or on the welcome page. It uses your Claude Pro or Max
   subscription. Either open claude.ai, approve, and paste the code it shows, or paste a token made with
   `claude setup-token`. One login serves every world on the server.
2. **Create a world.** Type a name at the top of the sidebar and press **Create**.
3. **Ask for something.** For example: *"Keep a todo list: add, toggle, delete, list. Then make an app page for it."*
4. **Watch it work.** The chat shows each change the agent tries. A kept change says which revision it became; a
   rejected one says why, and the agent usually tries again.
5. **Use it.** Open the **Functions** tab to call a function, or **Open app** to use the page.

On a phone, the **Chat** and **Inspect** buttons switch between the conversation and the inspector.

## The inspector

The panel next to the chat shows everything about the world. None of its tabs needs the agent.

| Tab | What you do there |
|---|---|
| **Functions** | See every function, its description and what it calls; call one with arguments and see the result. |
| **Revisions** | See each change and the code it added; roll back to any earlier revision. |
| **Incidents** | See calls that failed. **Ask the agent to fix it**, then **Retry now**; or answer the call yourself with a value; or **Dismiss** it with a reason. |
| **Rejected** | See every change the world turned away, and why. |
| **Data** | See what the world has stored, and delete entries. |
| **Checks** | See the rules every change must keep; remove one, with a reason. |
| **Access** | Choose which other worlds this world may call. |
| **Console** | Try an expression against the world without keeping anything it stores, or make a change by hand. |
| **App** | See the world's page. |

## Things you can ask for

- **New behaviour:** *"Add a due date to todos, and a function that lists the overdue ones."*
- **A change of mind:** *"Make reverseString keep the case of each letter."* Everything that uses the function picks
  up the new version, and the stored data is kept.
- **A guarantee:** *"Add a check that a total is never negative."* From then on, a change that would break it is
  rejected.
- **A page:** *"Make an app page for this."* It is served at `/w/<world id>/`.
- **A fix:** *"The call in incident 3 failed; fix it."* Then retry the call from the **Incidents** tab.
- **An undo:** *"Go back to revision 4."*, or use the **Revisions** tab yourself.

## Worlds working together

A world can use another world's functions instead of copying them. Ask for it in plain words:

> *"Use the Currency world to show the trip total in dollars."*

The agent finds the other world and its functions by itself. A new world may call any other world; to limit it, choose
the allowed worlds in its **Access** tab, and calls to any other world are refused. If the other world fails, the error says which world and function it came from, and you can
ask the agent how this world should handle it.

A typical set: a *Currency* world that converts amounts, a *Trip budget* world that records expenses and asks
*Currency* for totals, and a *Dashboard* world that shows open todos and trip spending from both.

## Using a world from a program

Every function can be called over HTTP, without the agent:

```sh
curl -X POST http://oracle-arm.mist-walleye.ts.net:8787/api/worlds/<world id>/call/<function> \
  -H 'content-type: application/json' -d '{"args": ["USD"]}'
```

The answer is the function's result as JSON. A call that fails stores nothing, so trying it again is safe. The world's
id is in the address bar when the world is open, and the **Functions** tab lists the function names and their
arguments. The README lists the rest of the API.

## Good to know

- **There is no login.** Anyone on the tailnet can open, change and call every world.
- **The agent cannot weaken your checks.** It can propose new ones; only you remove them.
- **A failed change costs nothing.** The world stays at its last good revision.
- **Changing the world keeps its data.** Rolling back changes the functions, not what has been stored.
- **A world calling another world is not a queue.** If the other world does not answer within 30 seconds, the call
  fails.
- **Previews are local.** Trying an expression in the **Console** keeps nothing this world stores, but a call it makes
  to another world is real.
