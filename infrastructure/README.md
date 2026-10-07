# Infrastructure

WP1: the "plumbing", built as infrastructure-as-code.

| Folder | Contents |
| :--- | :--- |
| `terraform/` | Cloud resources per environment and region: VPC, managed PostgreSQL, Elasticsearch, Redis cache, message bus, object storage (S3), CDN for i18n and media, WAF, DNS, secrets manager. |
| `kubernetes/` | Manifests and Helm charts for the backend services, AI/MCP pods, and workers. |
| `docker/` | Dockerfiles and `docker-compose` for local development (Postgres, Elasticsearch, Redis, bus, mail catcher). |

CI/CD pipelines live in `.github/workflows/`. Observability (logs, metrics, tracing, alerting), backups, and DR drills are also owned here.
