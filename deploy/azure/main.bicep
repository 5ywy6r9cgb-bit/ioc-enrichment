// One database. Nothing else.
// Azure Database for PostgreSQL Flexible Server (v16) holding the Sentinel PRA
// schema (modules/pra/migrations). No app service, no storage account, no
// Key Vault: add those later on purpose, not by default.
//
// Deploy:  az deployment group create -g <rg> -f deploy/azure/main.bicep -p serverName=<unique> clientIp=<your.public.ip> administratorPassword=<from prompt>

@description('Globally unique server name (3-63 chars, lowercase letters, digits, hyphens). It becomes <name>.postgres.database.azure.com.')
@minLength(3)
@maxLength(63)
param serverName string

@description('Region. Defaults to the resource group region.')
param location string = resourceGroup().location

@description('Server admin login. Not "postgres" or "admin" (Azure reserves them).')
param administratorLogin string = 'sentineladmin'

@description('Server admin password. Never put this in a file or in git.')
@secure()
param administratorPassword string

@description('Your public IPv4 address. It is the ONLY address allowed through the firewall.')
param clientIp string

@description('Database name.')
param databaseName string = 'sentinel_pra'

@description('Burstable B1ms is the smallest production-supported size.')
param skuName string = 'Standard_B1ms'

@description('Storage in GB (autogrow is on).')
@minValue(32)
param storageSizeGB int = 32

@description('Backup retention in days (7 to 35).')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  sku: {
    name: skuName
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Exactly one firewall rule: the operator's address. No 0.0.0.0 "Azure services" rule.
resource operatorOnly 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'operator-only'
  properties: {
    startIpAddress: clientIp
    endIpAddress: clientIp
  }
}

resource requireTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
  dependsOn: [ database ]
}

resource minTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'ssl_min_protocol_version'
  properties: {
    value: 'TLSv1.2'
    source: 'user-override'
  }
  dependsOn: [ requireTls ]
}

output host string = server.properties.fullyQualifiedDomainName
output database string = databaseName
output adminLogin string = administratorLogin
