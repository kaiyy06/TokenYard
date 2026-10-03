# Running in Docker

```sh
docker build -t tokenyard .
docker run -d --name tokenyard \
  -p 127.0.0.1:8787:8787 \
  -v tokenyard-data:/data \
  -e OPENROUTER_API_KEY \
  tokenyard
```

- **Publish on loopback only.** The gateway has no login of its own and passes your provider
  keys through. `-p 127.0.0.1:8787:8787` keeps it reachable from your machine and nothing else.
  Never publish it as `-p 8787:8787` on a shared or public host.
- **Data.** Usage records, the price cache and `config.yaml` live in the `/data` volume.
- **Routing.** Put a `config.yaml` in the volume (see the root README) and pass the decider's
  API key with `-e`. Without one, traffic passes through unchanged.
- **Agents.** Point them at `http://127.0.0.1:8787` as usual; `tokenyard init` run on the host
  does this for you.
- **Stats.** `docker exec tokenyard node dist/cli.mjs stats`
- **A local decider.** A Kev server on the host is reachable from the container at
  `host.docker.internal` (add `--add-host=host.docker.internal:host-gateway` on Linux); set
  `decider.base_url` to match.
