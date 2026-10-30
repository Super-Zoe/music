/**
 * 解码扩展设置
 *
 * 对应 src/core/decode 下的 IDecodePreferences。
 * 所有开关写入 PersistStatus("decode.prefs")，实时生效，无需重启。
 */

import ListItem from "@/components/base/listItem";
import ThemeSwitch from "@/components/base/switch";
import ThemeText from "@/components/base/themeText";
import { showDialog } from "@/components/dialogs/useDialog";
import decodeManager from "@/core/decode";
import { useI18N } from "@/core/i18n";
import { sizeFormatter } from "@/utils/fileUtils";
import Toast from "@/utils/toast";
import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

const DSD_SAMPLE_RATES = [44100, 88200, 176400];

export default function DecoderSetting() {
    const { t } = useI18N();
    const [prefs, setPrefsState] = useState(() => decodeManager.getPrefs());
    const [version, setVersion] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        decodeManager.getVersion().then(v => {
            if (alive) {
                setVersion(v);
            }
        });
        return () => {
            alive = false;
        };
    }, []);

    const update = (patch: Partial<typeof prefs>) => {
        setPrefsState(decodeManager.setPrefs(patch));
    };

    const clearCache = () => {
        showDialog("SimpleDialog", {
            title: t("dialog.clearDecodeCacheTitle"),
            content: t("dialog.clearDecodeCacheContent"),
            onOk() {
                decodeManager.trimCache().then(() => {
                    Toast.success(t("toast.decodeCacheCleared"));
                });
            },
        });
    };

    const chooseDsdRate = () => {
        showDialog("RadioDialog", {
            title: t("basicSettings.decoder.dsdSampleRate"),
            content: DSD_SAMPLE_RATES.map(rate => ({
                label: `${rate / 1000} kHz`,
                value: rate,
            })),
            defaultSelected: prefs.dsdTargetSampleRate,
            onOk(value: number) {
                update({ dsdTargetSampleRate: value });
            },
        });
    };

    const chooseLosslessTarget = () => {
        showDialog("RadioDialog", {
            title: t("basicSettings.decoder.losslessTarget"),
            content: [
                {
                    label: t("basicSettings.decoder.losslessTarget.flac"),
                    value: "flac",
                },
                {
                    label: t("basicSettings.decoder.losslessTarget.wav"),
                    value: "wav",
                },
            ],
            defaultSelected: prefs.losslessTarget,
            onOk(value: "flac" | "wav") {
                update({ losslessTarget: value });
            },
        });
    };

    return (
        <View>
            <ListItem
                withHorizontalPadding
                heightType="small"
                onPress={() => update({ enabled: !prefs.enabled })}>
                <ListItem.Content
                    title={t("basicSettings.decoder.enable")}
                    description={t("basicSettings.decoder.enableDesc")}
                />
                <ThemeSwitch
                    value={prefs.enabled}
                    onValueChange={v => update({ enabled: v })}
                />
            </ListItem>

            <ListItem withHorizontalPadding heightType="small">
                <ListItem.Content title={t("basicSettings.decoder.status")} />
                <ThemeText
                    style={styles.rightText}
                    fontColor={version ? "primary" : "text"}>
                    {version ?? t("basicSettings.decoder.status.notAvailable")}
                </ThemeText>
            </ListItem>

            <ListItem
                withHorizontalPadding
                heightType="small"
                onPress={() => update({ streamingEnabled: !prefs.streamingEnabled })}>
                <ListItem.Content
                    title={t("basicSettings.decoder.streaming")}
                    description={t("basicSettings.decoder.streamingDesc")}
                />
                <ThemeSwitch
                    value={prefs.streamingEnabled}
                    onValueChange={v => update({ streamingEnabled: v })}
                />
            </ListItem>

            <ListItem withHorizontalPadding heightType="small" onPress={chooseDsdRate}>
                <ListItem.Content title={t("basicSettings.decoder.dsdSampleRate")} />
                <ThemeText style={styles.rightText}>
                    {prefs.dsdTargetSampleRate / 1000} kHz
                </ThemeText>
            </ListItem>

            <ListItem
                withHorizontalPadding
                heightType="small"
                onPress={chooseLosslessTarget}>
                <ListItem.Content title={t("basicSettings.decoder.losslessTarget")} />
                <ThemeText style={styles.rightText}>
                    {prefs.losslessTarget === "flac"
                        ? t("basicSettings.decoder.losslessTarget.flac")
                        : t("basicSettings.decoder.losslessTarget.wav")}
                </ThemeText>
            </ListItem>

            <ListItem withHorizontalPadding heightType="small" onPress={clearCache}>
                <ListItem.Content
                    title={t("basicSettings.decoder.clearCache")}
                    description={`${t("basicSettings.decoder.cacheLimit")} ${sizeFormatter(
                        prefs.cacheLimitBytes,
                    )}`}
                />
            </ListItem>
        </View>
    );
}

const styles = StyleSheet.create({
    rightText: {
        alignSelf: "center",
    },
});
