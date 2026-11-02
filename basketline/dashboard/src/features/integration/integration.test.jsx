import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setRequestTenant } from '../../api/requestContext.js'
import { ApiKeysPanel } from './ApiKeysPanel.jsx'

const TENANT = '2b6f3e10-0000-4000-8000-0000000000aa'

function fakeService() {
  const keys = [{ prefix: 'bl_sk_Default', name: 'Default', createdAt: '2026-10-30T10:00:00.000Z', revokedAt: null }]
  return {
    keys,
    listApiKeys: vi.fn(async () => keys.map((k) => ({ ...k }))),
    createApiKey: vi.fn(async (name) => {
      const key = { prefix: `bl_sk_${name.slice(0, 3)}`, name, createdAt: '2026-10-30T11:00:00.000Z', revokedAt: null }
      keys.unshift(key)
      return { ...key, key: `${key.prefix}SECRETSECRET` }
    }),
    revokeApiKey: vi.fn(async (prefix) => {
      keys.find((k) => k.prefix === prefix).revokedAt = '2026-10-30T12:00:00.000Z'
    }),
  }
}

/** A fake of the allowed-websites calls, normalizing like auth-service. */
function fakeOrigins(initial = []) {
  let origins = [...initial]
  return {
    listAllowedOrigins: vi.fn(async () => [...origins]),
    setAllowedOrigins: vi.fn(async (next) => {
      if (next.some((origin) => !/^https?:\/\/[^/]+$/.test(origin.replace(/\/$/, '')))) throw new Error('origins[0] must be a website origin like https://shop.example (no path)')
      origins = [...new Set(next.map((origin) => new URL(origin).origin))]
      return [...origins]
    }),
  }
}

describe('ApiKeysPanel', () => {
  it('loads nothing until opened, then shows the SDK setup with this store and its keys', async () => {
    setRequestTenant(TENANT)
    const service = fakeService()
    const user = userEvent.setup()
    render(<ApiKeysPanel service={service} originsService={fakeOrigins()} />)
    expect(service.listApiKeys).not.toHaveBeenCalled()

    await user.click(screen.getByText('Integrate your site'))
    expect(await screen.findByRole('list', { name: 'API keys' })).toHaveTextContent('Default')
    expect(screen.getByTestId('integration-tenant-id')).toHaveTextContent(TENANT)
    expect(screen.getByLabelText('SDK setup code')).toHaveTextContent(`tenantId: '${TENANT}'`)
  })

  it('creates a key and shows it once, and revokes keys', async () => {
    setRequestTenant(TENANT)
    const service = fakeService()
    const user = userEvent.setup()
    render(<ApiKeysPanel service={service} originsService={fakeOrigins()} />)
    await user.click(screen.getByText('Integrate your site'))
    await screen.findByRole('list', { name: 'API keys' })

    expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled()
    await user.type(screen.getByLabelText('Key name'), 'Mobile app')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    expect(await screen.findByTestId('api-key-secret')).toHaveTextContent('bl_sk_MobSECRETSECRET')
    expect(screen.getByRole('note')).toHaveTextContent('it won’t be shown again')
    expect(service.createApiKey).toHaveBeenCalledWith('Mobile app')

    await user.click(screen.getByRole('button', { name: 'Revoke Default' }))
    await waitFor(() => expect(service.revokeApiKey).toHaveBeenCalledWith('bl_sk_Default'))
    const list = screen.getByRole('list', { name: 'API keys' })
    await waitFor(() => expect(within(list).getAllByText('Revoked')).toHaveLength(1))
    // The new key's secret stays visible until it's revoked or the page closes.
    expect(screen.getByTestId('api-key-secret')).toBeInTheDocument()
  })
})

describe('allowed websites', () => {
  it('warns that any website may send events until one is added, then lists, adds and removes them', async () => {
    setRequestTenant(TENANT)
    const origins = fakeOrigins()
    const user = userEvent.setup()
    render(<ApiKeysPanel service={fakeService()} originsService={origins} />)
    expect(origins.listAllowedOrigins).not.toHaveBeenCalled()
    await user.click(screen.getByText('Integrate your site'))
    expect(await screen.findByText(/Any website can send events for your store/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('Website address'), 'https://Shop.example/')
    await user.click(screen.getByRole('button', { name: 'Add website' }))
    const list = await screen.findByRole('list', { name: 'Allowed websites' })
    expect(list).toHaveTextContent('https://shop.example')
    expect(origins.setAllowedOrigins).toHaveBeenLastCalledWith(['https://Shop.example/'])
    expect(screen.getByLabelText('Website address')).toHaveValue('')

    await user.type(screen.getByLabelText('Website address'), 'https://shop.example/checkout')
    await user.click(screen.getByRole('button', { name: 'Add website' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('must be a website origin')
    expect(screen.getByLabelText('Website address')).toHaveValue('https://shop.example/checkout')

    await user.click(screen.getByRole('button', { name: 'Remove https://shop.example' }))
    expect(await screen.findByText(/Any website can send events for your store/)).toBeInTheDocument()
    expect(origins.setAllowedOrigins).toHaveBeenLastCalledWith([])
  })
})
