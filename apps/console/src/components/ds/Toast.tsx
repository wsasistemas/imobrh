interface ToastProps {
  /** Mensagem atual; vazia = escondido. Fica sempre montado para o leitor de tela anunciar (role=status). */
  message: string;
}

export function Toast({ message }: ToastProps) {
  return (
    <div className="ds-toast" role="status">
      {message}
    </div>
  );
}
