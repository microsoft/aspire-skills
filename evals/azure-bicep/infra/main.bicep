@description('Location for all resources.')
param location string = resourceGroup().location

@description('Environment short name, e.g. prod.')
param env string = 'prod'

// Standard, geo-redundant storage account for app data.
resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: '${env}data${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Standard_GRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

// Service Bus namespace used for background messaging.
resource serviceBus 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: '${env}-bus-${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
}

resource ordersQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: serviceBus
  name: 'orders'
}

// Azure Maps account used for geocoding. No first-class Aspire integration exists for this.
resource maps 'Microsoft.Maps/accounts@2023-06-01' = {
  name: '${env}-maps-${uniqueString(resourceGroup().id)}'
  location: 'global'
  sku: {
    name: 'G2'
  }
  kind: 'Gen2'
}

output storageBlobEndpoint string = storage.properties.primaryEndpoints.blob
output serviceBusEndpoint string = serviceBus.properties.serviceBusEndpoint
output mapsClientId string = maps.properties.uniqueId
