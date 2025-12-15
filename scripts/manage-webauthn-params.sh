#!/bin/bash

# WebAuthn SSM Parameter Store 管理スクリプト
# このスクリプトを使用して、各環境のWebAuthn設定を管理します

set -e

# 色付き出力用
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 使用方法を表示
usage() {
    echo "使用方法: $0 <command> <environment> [options]"
    echo ""
    echo "Commands:"
    echo "  set       - パラメータを設定（新規作成または更新）"
    echo "  get       - 現在のパラメータ値を取得"
    echo "  delete    - パラメータを削除"
    echo ""
    echo "Environment:"
    echo "  dev       - 開発環境"
    echo "  staging   - ステージング環境"
    echo "  prod      - 本番環境"
    echo ""
    echo "Options (set コマンドで使用):"
    echo "  --rp-id <value>           - WebAuthn Relying Party ID (例: dev.example.com)"
    echo "  --origin <value>          - WebAuthn Origin URL (例: https://dev.example.com/)"
    echo "  --strict-verify <value>   - Strict verify flag (true/false)"
    echo "  --region <value>          - AWS Region (デフォルト: ap-northeast-1)"
    echo ""
    echo "Examples:"
    echo "  # 新しい本番環境の設定"
    echo "  $0 set prod --rp-id example.com --origin https://example.com/ --strict-verify true"
    echo ""
    echo "  # 現在の設定を確認"
    echo "  $0 get prod"
    echo ""
    echo "  # 開発環境の設定を更新"
    echo "  $0 set dev --rp-id dev.example.com --origin https://dev.example.com/"
    exit 1
}

# 引数チェック
if [ $# -lt 2 ]; then
    usage
fi

COMMAND=$1
ENVIRONMENT=$2
shift 2

# デフォルト値
AWS_REGION="ap-northeast-1"
RP_ID=""
ORIGIN=""
STRICT_VERIFY=""

# オプション解析
while [[ $# -gt 0 ]]; do
    case $1 in
        --rp-id)
            RP_ID="$2"
            shift 2
            ;;
        --origin)
            ORIGIN="$2"
            shift 2
            ;;
        --strict-verify)
            STRICT_VERIFY="$2"
            shift 2
            ;;
        --region)
            AWS_REGION="$2"
            shift 2
            ;;
        *)
            echo -e "${RED}エラー: 不明なオプション: $1${NC}"
            usage
            ;;
    esac
done

# パラメータ名のプレフィックス
PARAM_PREFIX="/sample-app/${ENVIRONMENT}/webauthn"

# 現在の設定を取得
get_params() {
    echo -e "${GREEN}=== ${ENVIRONMENT} 環境の WebAuthn 設定 ===${NC}"
    echo ""

    echo -e "${YELLOW}WEBAUTHN_RP_ID:${NC}"
    aws ssm get-parameter \
        --name "${PARAM_PREFIX}/rp-id" \
        --region "${AWS_REGION}" \
        --query 'Parameter.Value' \
        --output text 2>/dev/null || echo "  (未設定)"

    echo ""
    echo -e "${YELLOW}WEBAUTHN_ORIGIN:${NC}"
    aws ssm get-parameter \
        --name "${PARAM_PREFIX}/origin" \
        --region "${AWS_REGION}" \
        --query 'Parameter.Value' \
        --output text 2>/dev/null || echo "  (未設定)"

    echo ""
    echo -e "${YELLOW}STRICT_WEBAUTHN_VERIFY:${NC}"
    aws ssm get-parameter \
        --name "${PARAM_PREFIX}/strict-verify" \
        --region "${AWS_REGION}" \
        --query 'Parameter.Value' \
        --output text 2>/dev/null || echo "  (未設定)"

    echo ""
}

# パラメータを設定
set_params() {
    if [ -z "$RP_ID" ] && [ -z "$ORIGIN" ] && [ -z "$STRICT_VERIFY" ]; then
        echo -e "${RED}エラー: 少なくとも1つのパラメータを指定してください${NC}"
        usage
    fi

    echo -e "${GREEN}=== ${ENVIRONMENT} 環境の WebAuthn 設定を更新中 ===${NC}"
    echo ""

    if [ -n "$RP_ID" ]; then
        echo -e "${YELLOW}WEBAUTHN_RP_ID を設定: ${NC}${RP_ID}"
        aws ssm put-parameter \
            --name "${PARAM_PREFIX}/rp-id" \
            --value "${RP_ID}" \
            --type String \
            --description "WebAuthn Relying Party ID for authentication" \
            --overwrite \
            --region "${AWS_REGION}"
        echo -e "${GREEN}✓ 完了${NC}"
        echo ""
    fi

    if [ -n "$ORIGIN" ]; then
        echo -e "${YELLOW}WEBAUTHN_ORIGIN を設定: ${NC}${ORIGIN}"
        aws ssm put-parameter \
            --name "${PARAM_PREFIX}/origin" \
            --value "${ORIGIN}" \
            --type String \
            --description "WebAuthn origin URL for authentication" \
            --overwrite \
            --region "${AWS_REGION}"
        echo -e "${GREEN}✓ 完了${NC}"
        echo ""
    fi

    if [ -n "$STRICT_VERIFY" ]; then
        echo -e "${YELLOW}STRICT_WEBAUTHN_VERIFY を設定: ${NC}${STRICT_VERIFY}"
        aws ssm put-parameter \
            --name "${PARAM_PREFIX}/strict-verify" \
            --value "${STRICT_VERIFY}" \
            --type String \
            --description "Whether to strictly verify WebAuthn credentials" \
            --overwrite \
            --region "${AWS_REGION}"
        echo -e "${GREEN}✓ 完了${NC}"
        echo ""
    fi

    echo -e "${GREEN}=== 設定完了！ ===${NC}"
    echo ""
    echo -e "${YELLOW}注意: ECSタスクが新しい環境変数を使用するには、サービスの再起動が必要です:${NC}"
    echo "  aws ecs update-service --cluster sample-app-${ENVIRONMENT}-cluster \\"
    echo "    --service sample-app-${ENVIRONMENT}-backend-svc --force-new-deployment \\"
    echo "    --region ${AWS_REGION}"
}

# パラメータを削除
delete_params() {
    echo -e "${RED}=== ${ENVIRONMENT} 環境の WebAuthn 設定を削除中 ===${NC}"
    echo ""
    echo -e "${YELLOW}本当に削除しますか? (y/N): ${NC}"
    read -r confirm

    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        echo "キャンセルしました"
        exit 0
    fi

    aws ssm delete-parameter --name "${PARAM_PREFIX}/rp-id" --region "${AWS_REGION}" 2>/dev/null || echo "rp-id: 既に削除されています"
    aws ssm delete-parameter --name "${PARAM_PREFIX}/origin" --region "${AWS_REGION}" 2>/dev/null || echo "origin: 既に削除されています"
    aws ssm delete-parameter --name "${PARAM_PREFIX}/strict-verify" --region "${AWS_REGION}" 2>/dev/null || echo "strict-verify: 既に削除されています"

    echo ""
    echo -e "${GREEN}削除完了${NC}"
}

# コマンド実行
case $COMMAND in
    get)
        get_params
        ;;
    set)
        set_params
        ;;
    delete)
        delete_params
        ;;
    *)
        echo -e "${RED}エラー: 不明なコマンド: $COMMAND${NC}"
        usage
        ;;
esac
