targetScope = 'subscription'

// Commit & Sip public leaderboard: one App Service plan and one web app.
// No storage account and no role assignment: the board lives on the app's own
// persistent /home storage, so nothing needs a data role or a key. The app's
// managed identity exists for policy compliance and holds no roles.
// See .azure/deployment-plan.md for why.

// westus3 was the first choice and had no B1 capacity at deployment time
// (2026-09-30), across two resource groups. The live app is in westus2.
@description('Azure region. Must be permitted by the subscription allowed-locations policy.')
param location string = 'westus2'

@description('Resource group to create or update.')
param resourceGroupName string = 'rg-commit-and-sip-lb-westus2'

@description('Globally unique app name. It fixes the public URL, which booth/local-config.json records before deployment.')
@minLength(2)
@maxLength(60)
param appName string

@description('Board partition. Change it to start a fresh board for a new event; the old one stays on disk.')
@minLength(1)
@maxLength(63)
param eventId string = 'default'

@description('Owner tag, matching the convention on existing resources in this subscription.')
param owner string

@secure()
@minLength(32)
@description('Publishes entries. Supplied from booth/local-config.json at deploy time; never committed.')
param boothKey string

@secure()
@minLength(32)
@description('Retracts entries. Supplied from booth/local-config.json at deploy time; never committed.')
param staffKey string

var tags = {
  owner: owner
  purpose: 'commit-and-sip-leaderboard'
  // Everything stored is shown on the public board; takedown records stay on
  // the booth machines. GH.15.08 levels: restricted, confidential, controlled, public.
  data_classification: 'public'
}

resource group 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module app 'modules/app.bicep' = {
  name: 'commit-and-sip-leaderboard-app'
  scope: group
  params: {
    location: location
    appName: appName
    eventId: eventId
    tags: tags
    boothKey: boothKey
    staffKey: staffKey
  }
}

output resourceGroupName string = group.name
output appName string = app.outputs.appName
output url string = app.outputs.url
