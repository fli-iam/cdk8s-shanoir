
import { ChartProps } from "cdk8s";
import { PersistentVolumeClaimProps } from "cdk8s-plus-33";


export interface ShanoirCredentials {
  readonly username: string;
  readonly password: string;
}

/** Parameters for accessing a Mysql/Mariadb/Posgresql database */
export interface ShanoirDatabaseProps extends ShanoirCredentials {
  readonly db: string;
  readonly host: string;
  readonly port?: number;
}

/** Default values for {@link ShanoirSmtpProps} */
export const shanoirSmtpDefaults = {
  port: 25,
  auth: undefined,
  starttls: "disabled" as "disabled",
};

/** SMTP configuration for outgoing mails */
export interface ShanoirSmtpProps {

  /** relay hostname/ip */
  readonly host: string;

  /** relay TCP port
   *
   * @default see {@link shanoirSmtpDefaults}
   */
  readonly port?: number;

  /** smtp user account
   *
   * @default no authentication
   */
  readonly auth?: ShanoirCredentials;

  /** STARTTLS configuration
   *
   * @default see {@link shanoirSmtpDefaults}
   */
  readonly starttls?: "disabled" | "optional" | "required";

  /** default sender address */
  readonly fromAddress: string;
}

/** Default values for {@link ShanoirVipProps} */
export const shanoirVipDefaults = {
  url: "https://vip.creatis.insa-lyon.fr",
  clientSecret: "SECRET",
  serviceEmail: "",
};

/** VIP (Virtual Imaging Platform) client configuration */
export interface ShanoirVipProps {
  readonly url: string;
  readonly clientSecret: string;
  readonly serviceEmail: string;
}


export const shanoirVolumes = [
  // medical data
  "datasets-data",
  "dcm4chee-arc-storage-data",
  "extra-data",
  "studies-data",

  // databases
  "database-data",
  "dcm4chee-database-data",
  "keycloak-database-data",

  // logs
  "logs",
  "keycloak-logs",

  // disposable data (temporary data, indexes, generated configs, ...)
  "dcm4chee-arc-wildfly-data",
  "dcm4chee-ldap-data",
  "dcm4chee-sldap-data",
  "rabbitmq-data",
  "solr-data",
  "tmp",
];

/** List of mysql databases to be provide in {@link ShanoirNGProps.mysqlDatabases} */
export const shanoirMysqlDatabases = [
  "datasets",
  "import",
  "keycloak",
  "migrations",
  "mysql",
  "preclinical",
  "studies",
  "sys",
  "users",
];

export const shanoirPostgresqlDatabases = [
  "dcm4chee",
];

function defaultMysqlDatabases(): {[key: string]: ShanoirDatabaseProps}
{
  var dbProps: {[key: string]: ShanoirDatabaseProps} = {};
  for (let db of shanoirMysqlDatabases) {
    dbProps[db] = {
      host: "INTERNAL",
      db: db,
      username: db,
      password: "password",
    };
  }
  return dbProps;
}

function defaultPostgresqlDatabases(): {[key: string]: ShanoirDatabaseProps}
{
  return {
    "dcm4chee": {
      host: "INTERNAL",
      db: "pacsdb",
      username: "pacs",
      password: "pacs",
    }};
}

export const defaultUids = {
  "database": 510,
  "rabbitmq": 511,
  "shanoir":  512,
  "keycloak-database": 513,
  "solr": 514,
  "keycloak": 1000,
}


/** Default values for {@link ShanoirNGProps} */
export const shanoirNGDefaults = {
  version: "NG_v2.10.0",
  instanceName: "",
  instanceColor: "",
  dockerRepository: "ghcr.io/fli-iam/shanoir-ng",
  allowedAdminIps: [],
  smtp: shanoirSmtpDefaults,
  vip: shanoirVipDefaults,
  createNamespace: true,
  mysqlDatabases: defaultMysqlDatabases(),
  postgresqlDatabases: defaultPostgresqlDatabases(),
  uids: defaultUids,
  init: false,
};

export interface ShanoirIngressProps {
  /** Ingress class */
  readonly className?: string

  /** TLS certificate (PEM format)
   *
   * It must cover the two domains listed in {@link ShanoirNGProps.url} and {@link
   * ShanoirNGProps.viewerUrl}.
   *
   * If unset then it is up to the ingress controller to generate a self-signed certificate.
   */
  readonly tlsCrt?: string;

  /** TLS key (PEM format) 
  *
  * see {@link tlsCrt}
  * */
  readonly tlsKey?: string;

  /** Expose the keycloak admin console and the master realm in the ingress rules
   *
   * By default the ingress rule only exposes the routes to the shanoir-ng realm (for security
   * reasons).
   */
  readonly exposeKeycloakAdminConsole?: boolean; 
};

export interface ShanoirNGProps extends ChartProps {

  /** Version of shanoir to be deployed (tag of the OCI images)
   *
   * @default use the latest release
   */
  readonly version?: string;

  /** Main url of this shanoir instance */
  readonly url: string;

  /** Url of the OHIF viewer */
  readonly viewerUrl: string;

  /** Name of this shanoir instance (displayed in the side panel) */
  readonly instanceName?: string;

  /** CSS color of this shanoir instance */
  readonly instanceColor?: string;

  /** Name of the administrator (for signing outgoing e-mails) */
  readonly adminName: string;

  /** E-mail of the administrator (for signing outgoing e-mails) */
  readonly adminEmail: string;

  /** Name of the OCI repository providing the shanoir images
   *
   * @default see {@link shanoirNGPropsDefaults}
   */
  readonly dockerRepository?: string;

  /** Mysql databases parameters
   *
   * If unset, this deployment will include a mysql container for hosting the databases.
   *
   * Otherwise the object must contain all keys listed in {@link shanoirMysqlDatabases}
   * (except 'keycloak' which may be omitted when using an external keycloak server)
   */
  readonly mysqlDatabases?: {[key: string]: ShanoirDatabaseProps};

  /** Postgresql databases 
   *
   * If unset, this deployment will include a postgresql container for hosting the databases.
   *
   * Otherwise the object must contain all keys listed in {@link shanoirPostgresqlDatabases}
   */
  readonly postgresqlDatabases?: {[key: string]: ShanoirDatabaseProps};

  /** SMTP parameters for outgoing emails */
  readonly smtp: ShanoirSmtpProps;

  /** List of client IP address or networks from which admin accounts are allowed to log in.
  *
  * @example ["192.0.2.1", "2001:db8:1::/64"]
  */
  readonly allowedAdminIps?: Array<string>;

  /** Url of the keycloak server (if external)
  *
  * If unset, this deployment will include a keycloak container reachable at `${this.url}/auth/`
  */
  readonly keycloakUrl?: string;

  /** Keycloak account (master realm) for managing users */
  readonly keycloakCredentials: ShanoirCredentials;

  /** VIP (Virtual Imaging Platform) client configuration
  *
  * Used by the CARMIN-API-CLIENT in the front of shanoir-ng to query for pipelines
  */
  readonly vip?: ShanoirVipProps;

  /** Volumes claim properties for this shanoir instance */
  readonly volumeClaimProps: { [key: string]: PersistentVolumeClaimProps};

  /** Ingress configuration */
  readonly ingress: ShanoirIngressProps;

  /** Create the kubernetes namespace
   *
   * @default see {@link shanoirNGPropsDefaults}
   */
  readonly createNamespace?: boolean;

  /** uid/gid to be assigned for each deployment/job
   *
   * The default security context generated by cdk8s forbids running containers as root.
   *
   * This hashmap list the uid (also the gid which is set to the samevalus) to be used in each pod
   * created by {@link ShanoirNGChart.createDeployment()} and {@link ShanoirNGChart.createJob}.
   * The hashmap keys are the values provided for the 'name' arguments of these function.
   *
   * @default see {@link shanoirNGPropsDefaults}
   */
  readonly uids?: {[key:string]: number};

  /** Flag for initialising a new shanoir instance
   *
   * Set this flag to 'true' when deploying a new shanoir instance.
   *
   * This will generate an additional chart with a name starting with 'danger-init-' and providing
   * the deployments and jobs to carry out the initial migrations.
   *
   * This additional chart performs destructive operations (especialy the databases are wiped out).
   * It must never be run on a pre-existing production instance.
   */
  readonly init?: boolean;
}
