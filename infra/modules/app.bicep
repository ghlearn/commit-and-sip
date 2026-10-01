param location string
param appName string
param eventId string
param tags object

@secure()
param boothKey string

@secure()
param staffKey string

// One B1 instance, deliberately: a booth needs no more. The board is a JSON
// file on /home. The platform can still briefly run a second instance, so the
// store locks and version-checks every write on the share rather than relying
// on this. Always On keeps it warm for the monitor, and the Free tier's daily
// CPU quota could stop the board mid-event.
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-${appName}'
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: 'B1'
    tier: 'Basic'
    capacity: 1
  }
  properties: {
    reserved: true
  }
}

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  tags: tags
  kind: 'app,linux'
  // Holds no role anywhere, so it grants nothing. Present because GitHub's App
  // Fundamentals policy audits apps without a managed identity.
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    // Deliberately off, and an accepted App Fundamentals audit finding: the
    // board is public and is read by phones that hold no client certificate.
    clientCertEnabled: false
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node leaderboard-service/server.mjs'
      alwaysOn: true
      numberOfWorkers: 1
      healthCheckPath: '/healthz'
      http20Enabled: true
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      remoteDebuggingEnabled: false
      appSettings: [
        { name: 'BOOTH_KEY', value: boothKey }
        { name: 'STAFF_KEY', value: staffKey }
        { name: 'EVENT_ID', value: eventId }
        { name: 'DATA_DIR', value: '/home/data/commit-and-sip' }
        // /home is the persistent share; this keeps it mounted.
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'true' }
        // Avoids overlapping workers within one VM during a recycle. It does not
        // cover scale operations or maintenance; the store's lock does.
        { name: 'WEBSITE_DISABLE_OVERLAPPED_RECYCLING', value: '1' }
        // The package is prebuilt and has no dependencies; nothing to build.
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
      ]
    }
  }
}

// Deployment authenticates with Entra ID. No FTP or basic-auth publishing
// credentials exist to leak.
resource ftpCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: site
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource scmCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: site
  name: 'scm'
  properties: {
    allow: false
  }
}

// On Linux this one setting is what gathers the container's stdout and stderr,
// so the service's console output (start-up, moderation warning, server
// errors) is kept here, not only HTTP access lines. `az webapp log config
// --docker-container-logging filesystem` writes exactly httpLogs.fileSystem;
// applicationLogs.fileSystem is the Windows equivalent and does nothing here.
// Three days and 35 MB: enough to read during an event, and no more.
resource logs 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: site
  name: 'logs'
  properties: {
    httpLogs: {
      fileSystem: {
        enabled: true
        retentionInMb: 35
        retentionInDays: 3
      }
    }
  }
}

output appName string = site.name
output url string = 'https://${site.properties.defaultHostName}'
