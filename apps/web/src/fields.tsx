import { useState } from 'react';
import { PasswordInput, type PasswordInputProps } from '@mantine/core';
import { useLanguage } from './i18n';

export function SecretInput(props: PasswordInputProps) {
  const [visible, setVisible] = useState(false); const { t } = useLanguage();
  return <PasswordInput {...props} visible={visible} onVisibilityChange={setVisible} rightSectionWidth={44} visibilityToggleButtonProps={{
    'aria-label': t(visible ? 'Hide secret' : 'Show secret'), tabIndex: 0,
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => { if (event.key === 'Enter') { event.preventDefault(); setVisible(value => !value); } },
  }} />;
}
