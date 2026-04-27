// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'

const fetchAuthStatusMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/auth', () => ({
  fetchAuthStatus: fetchAuthStatusMock,
  setupPassword: vi.fn(),
  changePassword: vi.fn(),
  changeUsername: vi.fn(),
  removePassword: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'login.setupDescription': 'setup-description',
        'login.passwordLoginConfigured': 'Password login enabled',
        'login.changePassword': 'Change Password',
        'login.changeUsername': 'Change Username',
        'login.removePasswordLogin': 'Remove',
      }

      return translations[key] ?? key
    },
  }),
}))

vi.mock('naive-ui', () => {
  const NButton = defineComponent({
    template: '<button><slot /></button>',
  })
  const NInput = defineComponent({
    template: '<input />',
  })
  const NModal = defineComponent({
    props: {
      show: {
        type: Boolean,
        default: false,
      },
    },
    template: '<div v-if="show"><slot /><slot name="action" /></div>',
  })
  const NForm = defineComponent({
    template: '<form><slot /></form>',
  })
  const NFormItem = defineComponent({
    props: {
      label: {
        type: String,
        default: '',
      },
    },
    template: '<label><span>{{ label }}</span><slot /></label>',
  })
  const NPopconfirm = defineComponent({
    template: '<div><slot name="trigger" /><slot /></div>',
  })

  return {
    NButton,
    NInput,
    NModal,
    NForm,
    NFormItem,
    NPopconfirm,
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
    }),
  }
})

import AccountSettings from '@/components/hermes/settings/AccountSettings.vue'

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

describe('AccountSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the configured password login state even when auth status username is null', async () => {
    fetchAuthStatusMock.mockResolvedValue({
      hasPasswordLogin: true,
      username: null,
    })

    const wrapper = mount(AccountSettings)

    await flushPromises()

    expect(fetchAuthStatusMock).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('Password login enabled')
    expect(wrapper.text()).toContain('Change Password')
    expect(wrapper.text()).not.toContain('null')
  })
})
