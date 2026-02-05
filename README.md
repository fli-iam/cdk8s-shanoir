# Shanoir NG Kubernetes Deployment

This CDK8s project converts the Shanoir NG Docker Compose configuration to Kubernetes manifests using CDK8s (Cloud Development Kit for Kubernetes).

## DISCLAIMER: this is a work in progress

The content of this repository is not ready for production.

## What's Included

The generated Kubernetes manifests include:

### Core Resources

- **Namespace**: `shanoir-ng` - isolates all Shanoir resources
- **ConfigMaps**: Configuration data for environment variables
- **Secrets**: Sensitive configuration data (passwords, certificates)
- **PersistentVolumeClaims**: Data persistence for all services

### Services Converted

1. **Authentication & Authorization**
   - Keycloak (identity management)
   - Keycloak Database (MySQL)

2. **Core Microservices**
   - Users service (9901/9911)
   - Studies service (9902/9912)
   - Import service (9903/9913)
   - Datasets service (9904/9914)
   - Preclinical service (9905/9915)
   - Nifti-conversion service

3. **Infrastructure Services**
   - RabbitMQ (message queue)
   - Main Database (MySQL)
   - Solr (search engine)
   - Nginx (load balancer/reverse proxy)

4. **PACS System (DCM4CHEE)**
   - LDAP server
   - PostgreSQL database
   - DCM4CHEE Arc server

### Networking

- **Services**: Internal cluster networking for all components
- **LoadBalancer**: External access via nginx service
- **Ingress**: HTTPS termination with cert-manager integration

## Prerequisites

1. **Kubernetes Cluster**: A running Kubernetes cluster with:
   - Sufficient resources (recommend 8+ CPU cores, 16GB+ RAM)
   - Storage provisioner for PersistentVolumes
   - Ingress controller (nginx recommended)
   - cert-manager for TLS certificates (optional but recommended)

2. **kubectl**: Configured to access your cluster

3. **Storage**: Ensure your cluster has a default storage class or modify the PVCs

## Configuration

Before deploying, update the following in `main.ts`:

1. **Domain Names**: Replace example domains:
   - `shanoir.example.com` → your actual domain
   - `ohif.example.com` → your OHIF viewer domain
   - `vip.example.com` → your VIP platform domain

2. **Secrets**: Update the secret values in the `shanoir-secrets` Secret:
   - Database passwords
   - Keycloak credentials
   - TLS certificates (base64 encoded)

3. **Storage**: Adjust PVC sizes based on your needs:
   - Database volumes: 20Gi (default)
   - Log volumes: 5Gi (default)

## Deployment Instructions

1. **Generate manifests**:

   ```bash
   npm run build
   ```

2. **Review generated manifests**:

   ```bash
   cat dist/shanoir-ng.k8s.yaml
   ```

3. **Deploy to Kubernetes**:

   ```bash
   kubectl apply -f dist/shanoir-ng.k8s.yaml
   ```

4. **Verify deployment**:

   ```bash
   kubectl get all -n shanoir-ng
   kubectl get pvc -n shanoir-ng
   ```

5. **Check pod status**:
   ```bash
   kubectl get pods -n shanoir-ng -w
   ```

## Important Notes

### Dependencies & Startup Order

The services have dependencies that may require manual intervention during first startup:

1. Databases should start first
2. Keycloak needs its database
3. Microservices need the main database and RabbitMQ
4. DCM4CHEE arc needs LDAP and PostgreSQL

### Environment Files

The original Docker Compose references environment files:

- `./docker-compose/database/variables.env`
- `./docker-compose/dcm4chee/variables.env`

You'll need to extract values from these files and add them to the ConfigMaps/Secrets.

### Certificates

Update the certificate placeholders in the secrets with actual base64-encoded certificates:

```bash
# Encode certificate files
cat your-cert.pem | base64 -w 0
cat your-key.pem | base64 -w 0
```

### Resource Limits

Consider adding resource requests and limits to containers based on your cluster capacity.

### High Availability

For production:

- Use multiple replicas for stateless services
- Configure database clustering
- Use external managed databases
- Set up monitoring and alerting

## Troubleshooting

1. **Pod stuck in Pending**: Check PVC binding and storage class
2. **ImagePullBackOff**: Verify image names and registry access
3. **Service communication**: Ensure all services are in the same namespace
4. **Database connection issues**: Check service names match environment variables

## Customization

To modify the deployment:

1. Edit `main.ts`
2. Run `npm run build`
3. Apply updated manifests

## Development

- **Build**: `npm run compile`
- **Test**: `npm run test`
- **Synth**: `npm run synth`
- **Full build**: `npm run build`

Important infos axel:
first first start: migration mode to init, everything will crash, and after that, restart with never/auto
