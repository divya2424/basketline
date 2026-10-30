# Basketline: Kubernetes deployment (Helm)

There is one Helm chart per service, and each service is its **own Helm release**. You can deploy, upgrade or roll back any service at any time without touching the others. [helmfile](https://github.com/helmfile/helmfile) deploys all of them, or any subset, with one command.

```
deploy/helm/
  helmfile.yaml.gotmpl      the seven releases (namespace basketline)
  environments/local/       per-release values for one environment (copy it for staging, production)
  charts/
    basketline-lib/         library chart: the templates every service chart shares
    gateway/  auth-service/  product-service/  campaign-service/  analytics-service/  flink-streaming/
      Chart.yaml            the chart's version and its dependency on basketline-lib
      values.yaml           everything you can set for this service
      templates/manifests.yaml
```

The releases don't wait for each other. A service whose database, Kafka or ClickHouse isn't reachable yet keeps restarting or stays unready until it is, and then joins on its own. So the order doesn't matter, and redeploying one service never redeploys another.

## Prerequisites

- **Kubernetes 1.27+, Helm 3 and helmfile 1.x**, plus the helm-diff plugin, which `helmfile apply` and `diff` use (`helm plugin install https://github.com/databus23/helm-diff`). Helm alone is enough for a single service ([below](#with-helm-only)).
- **Images in a registry the cluster can pull from.** From `backend/`:

  ```bash
  docker build --build-arg SERVICE=gateway -t <registry>/basketline/gateway:<version> .   # repeat per Node service
  docker build -t <registry>/basketline/flink-streaming:<version> flink
  docker build -t <registry>/basketline/airflow:<version> airflow
  ```

- **Postgres, Kafka and ClickHouse** must already exist; the charts don't install them. Postgres needs the roles and databases from `infra/postgres/init.sql`, and ClickHouse needs the schema files in `infra/clickhouse/` run in name order (`00_functions.sql` to `03_kafka.sql`, which reads Kafka at `kafka:19092`) and the storage policy in `infra/clickhouse/config/storage.xml`. The charts expect the hosts `postgres`, `kafka:19092` and `clickhouse` (the compose names). To use other hosts, set `config.KAFKA_BROKERS`, `config.KAFKA_BOOTSTRAP_SERVERS` (Flink), the connection strings under `secrets`, and `kafka_broker_list` in `03_kafka.sql`.

## Before the first deploy

All services verify tokens with the same key pair, so it lives in one Secret that no chart owns. That way no release depends on another release to create it:

```bash
kubectl create namespace basketline
kubectl -n basketline create secret generic basketline-jwt \
  --from-file=jwt-public.pem=keys/jwt-public.pem \
  --from-file=jwt-private.pem=keys/jwt-private.pem      # from backend/; `pnpm keys` creates them
```

Only auth-service mounts `jwt-private.pem`; the other services get only the public key.

## Deploy

From `deploy/helm/`:

```bash
helmfile -e local apply                                  # every service
helmfile -e local -l name=gateway apply                  # one service
helmfile -e local -l name=auth-service -l name=gateway apply             # several
helmfile -e local -l name=gateway apply --set image.tag=1.4.2            # a new version of one service
helmfile -e local -l name=gateway diff                   # what an apply would change
```

`apply` installs or upgrades and waits for the pods to be ready. If they never become ready, it rolls that release back. The release for each name has the same name, so `helm -n basketline history gateway` and `helm -n basketline rollback gateway` work as usual.

To remove one service, run `helmfile -e local -l name=gateway destroy`, or `helm -n basketline uninstall gateway`.

### With Helm only

```bash
helm dependency build charts/gateway       # packages basketline-lib into charts/gateway/charts/
helm upgrade --install gateway charts/gateway -n basketline \
  -f environments/local/gateway.yaml --wait --atomic
```

Run `helm dependency build` again after changing `charts/basketline-lib`. helmfile does this on every `apply`.

## Environments

An environment is a folder of values files, one per release, applied on top of the chart's `values.yaml`. The `local` environment uses the `docker compose build` images (`basketline-<service>:latest`), one replica each, and the compose development credentials. Its target is a local cluster that can reach the compose infrastructure under the names above.

To add production, copy the folder and register it in `helmfile.yaml.gotmpl` under `environments:` (`production: {}`). Then, in each file:
- set `image.repository` and `image.tag`;
- replace the `secrets` values with `existingSecret: <a Secret you manage>`, for example from External Secrets or Sealed Secrets, with the same keys. No passwords then go into Git or into Helm's release history;
- for the gateway, enable `ingress` and set `config.CORS_ORIGINS` to the frontend's origin;
- set `config.KAFKA_REPLICATION: "3"` on a three-broker Kafka;
- set the replicas, or `autoscaling.enabled: true`.

## What every chart sets up

| | |
|---|---|
| **Probes** | startup `/health/startup` (up to 5 min for migrations), liveness `/health/live`, readiness `/health/ready` (database or ClickHouse, plus Kafka) |
| **Rollouts** | `maxUnavailable: 0`: an old pod stops only after its replacement is ready. On `SIGTERM` a pod fails readiness, drains for 5 s, then finishes in-flight requests within the 35 s grace period |
| **Availability** | a PodDisruptionBudget (one pod down at a time) once there are 2+ replicas; pods spread across nodes where possible |
| **Security** | non-root (UID 1000; 9999 for Flink), read-only root filesystem with an in-memory `/tmp`, all capabilities dropped, `RuntimeDefault` seccomp, no Kubernetes API token |
| **Config** | `config` → ConfigMap, `secrets` → Secret (or `existingSecret`), both as environment variables. A changed value restarts the pods; a changed `existingSecret` doesn't, so run `kubectl rollout restart` after rotating it |
| **Autoscaling** | `autoscaling.enabled` adds an HPA on CPU (Node services) |

**flink-streaming** is a single-pod StatefulSet with a 5 Gi volume for its checkpoints (Kafka offsets and the attribution join's state). A StatefulSet never runs a second copy while the first is still stopping, which a Deployment can do during a node drain. Two copies would write the same checkpoints. The chart refuses `replicaCount` other than 1. The volume survives `helm uninstall`; to start from scratch, delete the PVC `data-flink-streaming-0`. That replays Kafka from `KAFKA_STARTUP_MODE` (see `flink/README.md` before doing it).

The pod runs a job manager and a task manager together, like a small Flink session cluster. To scale past one pod, run the same `flink/sql/` job with the [Flink Kubernetes Operator](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-stable/) instead: separate job and task manager pods, more task managers for more parallelism, checkpoints on S3, and `upgradeMode: last-state` so upgrades resume from the latest checkpoint.

**airflow** uses the official [Apache Airflow chart](https://airflow.apache.org/docs/helm-chart/) (pinned in the helmfile) with the `airflow/` image, which has the DAGs and jobs baked in. It uses the KubernetesExecutor, so each task runs in its own pod and only the scheduler and API server run between the nightly jobs. Its metadata goes to `airflow_db` in the existing Postgres. `environments/local/airflow.yaml` holds the job's environment; on AWS, switch the catalog to Glue and give the service account an IAM role (`airflow/README.md`, "On AWS").

## Things to know

- **Rate limits are per pod.** The gateway counts requests in memory, so with 3 replicas a client can make up to 3× `RATE_LIMIT_PER_MINUTE`. It trusts one `X-Forwarded-For` hop for the client IP, so put exactly one proxy, the Ingress controller, in front of it.
- **Migrations run at startup in every pod.** On a fresh install with several replicas, the pods can race on the first migration. A pod that loses the race exits and restarts, and then finds the migration applied. Upgrades roll out one new pod at a time, so they don't race.
- **Topics are created by the services.** analytics-service creates the `analytics.*` topics that Flink reads and the `serving.*` topics it writes, so deploy analytics-service before the first flink-streaming deploy.
