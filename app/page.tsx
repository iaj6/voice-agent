import { Console } from "@/components/Console";
import { PROTOCOL } from "@/lib/clinical/protocol";

export default function Page() {
  return (
    <Console
      protocol={{
        protocolId: PROTOCOL.protocolId,
        shortTitle: PROTOCOL.shortTitle,
        title: PROTOCOL.title,
        phase: PROTOCOL.phase,
        sponsor: PROTOCOL.sponsor,
        investigationalProduct: PROTOCOL.investigationalProduct,
        solicitedSymptoms: PROTOCOL.solicitedSymptoms.map((s) => s.term),
      }}
    />
  );
}
