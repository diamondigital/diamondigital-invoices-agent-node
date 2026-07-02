function classifyResults(results) {
	return {
		ok: results.filter(r => r.success),
		skip: results.filter(r => !r.success && r.skipped),
		fail: results.filter(r => !r.success && !r.skipped),
	};
}

export function buildSummaryLines(results) {
	const { ok, skip, fail } = classifyResults(results);

	const lines = [
		'📊 Diamondigital Documents Upload — Denní přehled',
		'────────────────────────────────────────',
		`Celkem e-mailů: ${results.length}`,
		`✅ Úspěšně nahráno: ${ok.length}`,
		`⚠️  Chyby: ${fail.length}`,
		`⏭️  Přeskočeno (není účetní doklad): ${skip.length}`,
	];

	if (ok.length > 0) {
		lines.push('', 'Nahrané dokumenty:');
		for (const r of ok) {
			const detail = (r.classifications || [])
				.filter(c => c.uploaded)
				.map(c => `${c.docType} ${Math.round((c.confidence || 0) * 100)}%`)
				.join(', ');
			lines.push(`  • ${r.uploadedCount || 0} příloha/y ← "${r.subject}"${detail ? ` [${detail}]` : ''}`);
		}
	}

	if (skip.length > 0) {
		lines.push('', '⏭️  Přeskočené e-maily:');
		for (const r of skip) {
			const borderline = (r.classifications || [])
				.filter(c => c.isAccountingDocument && !c.uploaded)
				.map(c => `${c.filename}: ${c.docType} ${Math.round((c.confidence || 0) * 100)}%`);
			lines.push(`  • "${r.subject}" — ${r.skipReason}`);
			for (const b of borderline) lines.push(`      ⚠ možný doklad pod prahem: ${b}`);
		}
	}

	if (fail.length > 0) {
		lines.push('', '❌ Chyby:');
		for (const r of fail) {
			lines.push(`  • "${r.subject}": ${r.error}`);
		}
	}

	return lines;
}

export async function sendSummary(results, notification) {
	const { fail } = classifyResults(results);
	const lines = buildSummaryLines(results);

	if (fail.length > 0) {
		await notification.sendAlert(
			`${fail.length} document upload(s) failed`,
			fail.map(r => `- ${r.subject}: ${r.error}`).join('\n')
		);
	}

	await notification.sendSummary(lines.join('\n'));
}
