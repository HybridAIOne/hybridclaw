# Mermaid Type Reference

Use these examples as the starting grammar for `diagram_validate` and `diagram_create`.

## sequence

```mermaid
sequenceDiagram
  participant User
  participant Gateway
  participant Worker
  User->>Gateway: Submit request
  Gateway->>Worker: Start job
  Worker-->>Gateway: Result
  Gateway-->>User: Response
```

## flowchart

```mermaid
flowchart TD
  A[Request] --> B{Valid?}
  B -->|Yes| C[Process]
  B -->|No| D[Reject]
  C --> E[Done]
```

## state

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Review: submit
  Review --> Approved: approve
  Review --> Draft: request changes
  Approved --> [*]
```

## er

```mermaid
erDiagram
  USER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  USER {
    string id
    string email
  }
  ORDER {
    string id
    date created_at
  }
```

## class

```mermaid
classDiagram
  class Provider {
    +string id
    +run()
  }
  class OpenAIProvider
  Provider <|-- OpenAIProvider
```

## gantt

```mermaid
gantt
  title Release Plan
  dateFormat  YYYY-MM-DD
  section Build
  Implement :a1, 2026-01-01, 3d
  Test :after a1, 2d
```

## git-graph

```mermaid
gitGraph
  commit id: "base"
  branch feature
  checkout feature
  commit id: "work"
  checkout main
  merge feature
```

## mindmap

```mermaid
mindmap
  root((Diagram Skill))
    Create
    Validate
    Render
```

## pie

```mermaid
pie title Usage
  "Create" : 50
  "Update" : 30
  "Validate" : 20
```
