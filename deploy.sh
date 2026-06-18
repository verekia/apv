docker buildx build --platform linux/arm64 --load -t verekia/apv .
docker save verekia/apv | gzip > /tmp/apv.tar.gz
scp /tmp/apv.tar.gz midgar:/tmp/
ssh midgar docker load --input /tmp/apv.tar.gz
ssh midgar docker compose up -d apv
